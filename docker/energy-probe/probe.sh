#!/bin/sh
# What energy instrumentation a Cloudflare Container can see from inside itself.
#
# The roadmap asserts that a container cannot read its own joules because RAPL lives in host MSRs.
# That is an architectural argument, not a measurement: a hypervisor CAN synthesise a per-VM energy
# counter (QEMU does), so the only thing that settles it is looking. This prints every interface a
# Linux process could obtain energy from, present or absent, so the answer is an observation.
#
# The first run found a Firecracker microVM with full capabilities, no seccomp filter, a writable
# sysfs and /dev/cpu/0/msr present -- so the sysfs half of the question is closed and the MSR half
# is not, which is what the msr sections below exist to settle.

echo "Content-Type: text/plain; charset=utf-8"
echo ""

section() {
	echo ""
	echo "=== $1 ==="
}
show() {
	if [ -e "$1" ]; then
		echo "--- $1"
		cat "$1" 2>&1 | head -"${2:-40}"
	else
		echo "--- $1: ABSENT"
	fi
}

# AMD's RAPL MSRs, then Intel's. Reads through msr-tools where the package exists and through dd
# otherwise; the msr driver takes the MSR number as the file OFFSET and refuses a read that is not
# 8 bytes, which is why bs=1 cannot do this and skip_bytes is required.
readmsr() {
	label="$1"
	num="$2"
	if command -v rdmsr > /dev/null 2>&1; then
		echo "--- $label ($num) rdmsr: $(rdmsr -0 "$num" 2>&1)"
	fi
	dec=$(printf '%d' "$num" 2> /dev/null)
	if [ -n "$dec" ]; then
		# stderr goes to a file rather than down the pipe: folded in, dd's own "I/O error" text
		# arrives at od and is hexdumped as though it were the counter's value
		val=$(dd if=/dev/cpu/0/msr bs=8 count=1 iflag=skip_bytes skip="$dec" 2> /tmp/msr.err | od -An -tx8 | tr -d ' \n')
		err=$(grep -i 'error\|denied\|permitted' /tmp/msr.err | head -1)
		echo "--- $label ($num) dd: ${val:-<no bytes>} ${err:+[$err]}"
	fi
}

# Every energy_uj under a root, read through ONE code path so the control and the real tree cannot
# differ in how they are read. An absent counter and an absent READER look identical from outside,
# which is what the control below exists to separate.
scanPowercap() {
	root="$1"
	found=$(find "$root" -name 'energy_uj' 2> /dev/null)
	if [ -z "$found" ]; then
		echo "no energy_uj under $root"
		return 1
	fi
	for c in $found; do
		echo "  $(dirname "$c")/$(cat "$(dirname "$c")/name" 2> /dev/null || echo unnamed) = $(cat "$c" 2>&1) uJ"
	done
	return 0
}

# A powercap tree with the shape the kernel's intel-rapl driver publishes, whose counter is derived
# from the cgroup CPU time this container has actually burned times a published W/core.
#
# It is a CONTROL, not a measurement: it proves the reader above finds, reads and deltas a counter
# when one exists, so "absent" from the real tree is an observation rather than a broken probe. The
# coefficient is illustrative and the real one has to be fitted on a host where RAPL is readable.
fakePowercap() {
	root=/tmp/fake-powercap/intel-rapl:0
	mkdir -p "$root"
	echo "package-0" > "$root/name"
	us=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat 2> /dev/null)
	[ -z "$us" ] && us=0
	# uJ = microseconds x watts. 3.75 W/core is EPYC 9654's 360 W TDP over 96 cores.
	echo $((us * WPC_NUM / WPC_DEN)) > "$root/energy_uj"
}

WPC_NUM=$(echo "$QUERY_STRING" | sed -n 's/.*wnum=\([0-9]*\).*/\1/p')
WPC_DEN=$(echo "$QUERY_STRING" | sed -n 's/.*wden=\([0-9]*\).*/\1/p')
[ -z "$WPC_NUM" ] && WPC_NUM=375
[ -z "$WPC_DEN" ] && WPC_DEN=100

echo "cfw energy probe, $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

section "identity"
uname -a
show /proc/version
for f in sys_vendor product_name product_version bios_vendor board_name; do
	show "/sys/class/dmi/id/$f" 2
done
show /sys/hypervisor/type 2
echo "--- dmesg (first 25)"
dmesg 2>&1 | head -25

section "cpu"
echo "--- nproc: $(nproc 2>&1)"
grep -m3 -E 'model name|vendor_id|cpu MHz|cpu family|^model|stepping' /proc/cpuinfo 2>&1
echo "--- flags"
grep -m1 '^flags' /proc/cpuinfo 2>&1 | tr ' ' '\n' | grep -E 'rapl|hwp|aperfmperf|energy|tsc|constant|msr|cpb' | tr '\n' ' '
echo ""
echo "--- cpuid 0x80000007 (AMD advertises RAPL in EDX bit 14, core perf boost in EDX bit 9)"
if command -v cpuid > /dev/null 2>&1; then
	cpuid -1 -l 0x80000007 2>&1 | head -25
else
	echo "cpuid not installed in this image"
fi

section "powercap (the RAPL sysfs interface)"
echo "--- ls /sys/class/powercap"
ls -l /sys/class/powercap 2>&1
echo "--- ls /sys/devices/virtual/powercap"
ls -l /sys/devices/virtual/powercap 2>&1
echo "--- find /sys -iname '*rapl*'"
find /sys -iname '*rapl*' 2> /dev/null | head -40
echo "--- find /sys -iname '*energy*'"
find /sys -iname '*energy*' 2> /dev/null | head -40

section "perf PMUs"
show /proc/sys/kernel/perf_event_paranoid 2
echo "--- ls /sys/bus/event_source/devices"
ls -l /sys/bus/event_source/devices 2>&1
for pmu in /sys/bus/event_source/devices/*; do
	[ -d "$pmu/events" ] || continue
	echo "--- $(basename "$pmu") events: $(ls "$pmu/events" 2>&1 | tr '\n' ' ')"
done
echo "--- perf list (full)"
if command -v perf > /dev/null 2>&1; then
	perf list 2>&1 | head -120
else
	echo "perf not installed in this image"
fi

section "perf energy attempt"
if command -v perf > /dev/null 2>&1; then
	for ev in power/energy-pkg/ power/energy-cores/ power/energy-ram/ energy-pkg energy-cores; do
		echo "--- perf stat -e $ev -- sleep 0.2"
		perf stat -e "$ev" -- sleep 0.2 2>&1 | grep -v '^$' | head -8
	done
else
	echo "perf not installed in this image"
fi

section "msr device"
echo "--- ls -R /dev/cpu"
ls -lR /dev/cpu 2>&1 | head -20
echo "--- msr-tools present: $(command -v rdmsr 2>&1 || echo no)"
readmsr MSR_AMD_RAPL_POWER_UNIT 0xC0010299
readmsr MSR_AMD_CORE_ENERGY_STATUS 0xC001029A
readmsr MSR_AMD_PKG_ENERGY_STATUS 0xC001029B
readmsr MSR_INTEL_RAPL_POWER_UNIT 0x606
readmsr MSR_INTEL_PKG_ENERGY_STATUS 0x611
readmsr MSR_INTEL_PP0_ENERGY_STATUS 0x639
readmsr MSR_IA32_TSC 0x10
readmsr MSR_IA32_APERF 0xE8
readmsr MSR_IA32_MPERF 0xE7

# a counter that reads is not yet a counter that MOVES, and a constant is what an unhandled MSR
# returns when KVM is told to ignore rather than fault
section "msr delta across a burn"
BURN=$(echo "$QUERY_STRING" | sed -n 's/.*burn=\([0-9]*\).*/\1/p')
[ -z "$BURN" ] && BURN=3
echo "burning ${BURN}s"
echo "-- before"
readmsr MSR_AMD_PKG_ENERGY_STATUS 0xC001029B
readmsr MSR_AMD_CORE_ENERGY_STATUS 0xC001029A
readmsr MSR_IA32_APERF 0xE8
readmsr MSR_IA32_MPERF 0xE7
END=$(($(date +%s) + BURN))
while [ "$(date +%s)" -lt "$END" ]; do :; done
echo "-- after"
readmsr MSR_AMD_PKG_ENERGY_STATUS 0xC001029B
readmsr MSR_AMD_CORE_ENERGY_STATUS 0xC001029A
readmsr MSR_IA32_APERF 0xE8
readmsr MSR_IA32_MPERF 0xE7

# the positive half. A software power meter (PowerAPI/SmartWatts, Kepler's estimator) is a
# regression from hardware counters onto watts, fitted where RAPL IS readable and then applied
# where it is not -- so whether these counters COUNT inside the guest decides whether that route
# is open at all.
section "hardware counters over a burn (the input a fitted power model would use)"
if command -v perf > /dev/null 2>&1; then
	BURNER="END=\$((\$(date +%s) + $BURN)); while [ \"\$(date +%s)\" -lt \"\$END\" ]; do :; done"
	for set in cycles,instructions,task-clock cache-misses,cache-references,branch-misses msr/tsc/ ref-cycles,stalled-cycles-frontend; do
		echo "--- perf stat -e $set over ${BURN}s"
		perf stat -e "$set" -- sh -c "$BURNER" 2>&1 | grep -vE '^$|Performance counter stats' | head -10
	done
fi

# WITHOUT THIS THE NEGATIVE RESULT IS UNREADABLE. A probe that reports "absent" because it cannot
# read is indistinguishable from one reporting "absent" because nothing is there, and this project
# has shipped that mistake before.
section "CONTROL: the same reader against a counter that DOES exist"
echo "--- real tree /sys/class/powercap"
scanPowercap /sys/class/powercap && echo "REAL: found" || echo "REAL: absent"
fakePowercap
echo "--- control tree /tmp/fake-powercap (derived from cgroup cpu time x ${WPC_NUM}/${WPC_DEN} W/core)"
scanPowercap /tmp/fake-powercap && echo "CONTROL: found" || echo "CONTROL: absent -- THE READER IS BROKEN"

section "CONTROL: does the derived counter MOVE with work"
for level in idle light heavy; do
	before=$(cat /tmp/fake-powercap/intel-rapl:0/energy_uj 2> /dev/null)
	cpu0=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat)
	t0=$(date +%s)
	case "$level" in
		idle) sleep "$BURN" ;;
		light)
			END=$(($(date +%s) + BURN))
			while [ "$(date +%s)" -lt "$END" ]; do sleep 0.05; done
			;;
		heavy)
			END=$(($(date +%s) + BURN))
			while [ "$(date +%s)" -lt "$END" ]; do :; done
			;;
	esac
	t1=$(date +%s)
	cpu1=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat)
	fakePowercap
	after=$(cat /tmp/fake-powercap/intel-rapl:0/energy_uj 2> /dev/null)
	wall=$((t1 - t0))
	dcpu=$((cpu1 - cpu0))
	duj=$((after - before))
	# integer millijoules and a duty percent, because the shell has no floats
	echo "$level: wall ${wall}s, cgroup cpu ${dcpu}us, duty $((wall > 0 ? dcpu / (wall * 10000) : 0))%, derived $((duj / 1000)) mJ"
done

section "hwmon, power_supply, thermal"
echo "--- ls /sys/class/hwmon"
ls -l /sys/class/hwmon 2>&1
echo "--- ls /sys/class/power_supply"
ls -l /sys/class/power_supply 2>&1
echo "--- ls /sys/class/thermal"
ls -l /sys/class/thermal 2>&1

section "cpufreq and cpuidle (inputs to a power model)"
echo "--- ls /sys/devices/system/cpu"
ls /sys/devices/system/cpu 2>&1 | tr '\n' ' '
echo ""
echo "--- ls /sys/devices/system/cpu/cpu0"
ls /sys/devices/system/cpu/cpu0 2>&1 | tr '\n' ' '
echo ""
show /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2

section "cgroup accounting (what the arm CAN measure)"
show /proc/self/cgroup 5
show /sys/fs/cgroup/cpu.stat 10
show /proc/stat 3
show /proc/uptime 2

section "privileges"
grep -E 'Cap(Inh|Prm|Eff|Bnd)|Seccomp' /proc/self/status 2>&1
echo "--- id: $(id 2>&1)"
echo "--- mounts carrying sys/proc/dev"
grep -E ' /(sys|proc|dev)' /proc/mounts 2>&1 | head -20

echo ""
echo "=== end ==="
