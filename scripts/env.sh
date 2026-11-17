# Sourced by check.sh and the generators. Puts the pinned toolchain first on PATH when it is installed
# where build.md step 1 puts it ($KUBI_TOOLCHAIN, by default ~/.local/opt/kubi), then checks the versions.
KUBI_TOOLCHAIN="${KUBI_TOOLCHAIN:-$HOME/.local/opt/kubi}"
if [ -d "$KUBI_TOOLCHAIN" ]; then
  export PATH="$KUBI_TOOLCHAIN/node/bin:$KUBI_TOOLCHAIN/go/bin:$KUBI_TOOLCHAIN/bin:$PATH"
  export COREPACK_HOME="$KUBI_TOOLCHAIN/corepack"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
kubi_need() { # kubi_need <tool> <wanted prefix> <version command...>
  local tool="$1" want="$2"; shift 2
  command -v "$tool" >/dev/null || { echo "missing $tool (want $want); see README.md, Toolchain" >&2; return 1; }
  local got; got="$("$@" 2>&1 | head -1)"
  case "$got" in *"$want"*) ;; *) echo "$tool is '$got', want $want; see README.md, Toolchain" >&2; return 1 ;; esac
}
