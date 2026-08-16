#!/usr/bin/env bash
# Builds the zstd decoder the interpreter seam inflates with.
#
# The interpreter ships as a zstd frame because Cloudflare measures the bundle after its own gzip.
# Inflating that frame in pure JS measured ~257 ms of a ~274 ms startup -- 94% of it. This decoder is
# wasm imported as `CompiledWasm`, so the platform compiles it ahead of the isolate, and it took the
# same startup to a median of 112 ms (n=5).
#
# Decompress only, no compressor, no dictBuilder, no legacy formats, and error strings stripped:
# 65,014 bytes raw, ~24,798 gzipped. It has ONE import,
# `env.emscripten_notify_memory_growth`, which the consumer stubs.
#
# The output is gitignored on purpose -- this repo does not commit binaries. Re-run after a clone.
#
# It is also CACHED, because the inputs are pinned: one zstd tarball verified by sha256, compiled by
# one pinned emsdk image. Re-running produces the same 65 KB, so an existing decoder is reused and
# Docker is never started. `--force` (or FORCE=1) rebuilds it anyway.
#
# usage: scripts/build-zstd-decoder.sh [out-dir] [--force]
set -euo pipefail

FORCE="${FORCE:-0}"
OUT_DIR=""
for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
		*) OUT_DIR="$arg" ;;
	esac
done
OUT_DIR="${OUT_DIR:-.interp}"
ZSTD_VERSION="${ZSTD_VERSION:-1.5.6}"
ZSTD_SHA256="30f35f71c1203369dc979ecde0400ffea93c27391bfd2ac5a9715d2173d92ff7"
# the emsdk the php binaries were built with, so the decoder cannot drift onto a newer LLVM
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:3.1.68}"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

# cached: the inputs are pinned, so an existing decoder is the same decoder
if [ "$FORCE" != "1" ] && [ -s "$OUT_DIR/zstddec.wasm" ]; then
	echo "$OUT_DIR/zstddec.wasm  $(wc -c < "$OUT_DIR/zstddec.wasm" | tr -d ' ') bytes, already built (--force rebuilds)"
	exit 0
fi

command -v docker > /dev/null || fail "docker is required to build the decoder"
docker info > /dev/null 2>&1 || fail "docker is installed but not running; start it and re-run"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL="$WORK/zstd.tar.gz"
echo "fetching zstd $ZSTD_VERSION"
curl -fsSL -o "$TARBALL" \
	"https://github.com/facebook/zstd/archive/refs/tags/v${ZSTD_VERSION}.tar.gz" \
	|| fail "could not download zstd $ZSTD_VERSION"

# verified, because an unpinned decoder is a supply chain the interpreter passes through
actual="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
[ "$actual" = "$ZSTD_SHA256" ] \
	|| fail "zstd $ZSTD_VERSION sha256 is $actual, expected $ZSTD_SHA256"

tar -xzf "$TARBALL" -C "$WORK"
SRC="$WORK/zstd-${ZSTD_VERSION}/lib"
[ -d "$SRC/decompress" ] || fail "no lib/decompress in the extracted tree"

mkdir -p "$OUT_DIR"
OUT_ABS="$(cd "$OUT_DIR" && pwd)/zstddec.wasm"

echo "compiling with $EMSDK_IMAGE"
docker run --rm -u "$(id -u):$(id -g)" \
	-v "$SRC:/zstd" -v "$(dirname "$OUT_ABS"):/out" \
	-w /zstd "$EMSDK_IMAGE" \
	emcc -O3 -flto \
	-DZSTD_LIB_COMPRESSION=0 -DZSTD_LIB_DICTBUILDER=0 -DZSTD_LEGACY_SUPPORT=0 \
	-DZSTD_STRIP_ERROR_STRINGS=1 -DHUF_DISABLE_ASM=1 -DZSTD_DISABLE_ASM=1 \
	-I. -Icommon \
	common/entropy_common.c common/error_private.c common/fse_decompress.c \
	common/xxhash.c common/zstd_common.c \
	decompress/zstd_decompress.c decompress/zstd_decompress_block.c \
	decompress/zstd_ddict.c decompress/huf_decompress.c \
	-sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_FUNCTIONS=_ZSTD_decompress,_ZSTD_getFrameContentSize,_ZSTD_isError,_malloc,_free \
	-o /out/zstddec.wasm \
	|| fail "the emcc build failed"

[ -s "$OUT_ABS" ] || fail "emcc reported success but produced no $OUT_ABS"
size="$(wc -c < "$OUT_ABS" | tr -d ' ')"
echo "$OUT_ABS  $size bytes"

# a decoder missing any of these cannot be driven by cartridge's zstdDecoderFromWasm
for symbol in ZSTD_decompress ZSTD_isError malloc free memory; do
	grep -qa "$symbol" "$OUT_ABS" || fail "the built decoder exports no $symbol"
done
echo "exports look right: ZSTD_decompress, ZSTD_isError, malloc, free, memory"
