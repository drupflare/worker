# Does a Cloudflare Container expose any energy counter to the workload inside it?
#
# The roadmap answers no from architecture: RAPL is a host MSR and a sandboxed runtime does not
# mount it in. That is a plausible argument rather than an observation, and a hypervisor can
# synthesise a per-VM energy counter instead of passing the host's through -- QEMU ships one. So
# the question is settled by looking, and this image is the smallest thing that can look.
#
# Nothing here is part of the VPS comparison arm. It reuses that arm's Worker, its budget guard and
# its instance sizing, and replaces the payload with a probe.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# alpine's own busybox is built WITHOUT the httpd applet, so `busybox httpd` exits 127 with
# "applet not found" and the platform reports only that the container exited. `busybox-extras`
# carries it.
#
# perf is the second route to RAPL (`power/energy-pkg/`) and reads it through a PMU rather than
# sysfs; msr-tools is the third and reads the counter MSR directly, which is the one route a
# microVM guest with /dev/cpu/0/msr could still have. Each is optional and the probe reports which
# of them it got, because an absent tool and an absent counter must not read alike.
RUN apk add --no-cache busybox-extras; \
	for p in perf msr-tools cpuid; do \
		apk add --no-cache "$p" || echo "$p unavailable for this arch/release"; \
	done

COPY probe.sh /www/cgi-bin/probe
RUN chmod +x /www/cgi-bin/probe

EXPOSE 8080
CMD ["httpd", "-f", "-vv", "-p", "8080", "-h", "/www"]
