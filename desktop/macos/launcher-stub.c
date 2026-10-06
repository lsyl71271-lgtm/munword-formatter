// PKUNMUN 2026 文件排版系统 — native entry point of the macOS app (Contents/MacOS/PKUNMUN2026).
// A bundle whose executable is a script counts as an Intel app on Apple silicon, so macOS would ask to
// install Rosetta before opening it. This universal (arm64 + x86_64) program only hands over to
// Contents/Resources/launcher.sh, which holds the actual logic, using the system shell.
// Built by desktop/macos/build-stub.sh; the committed binary is launcher-stub.
#include <mach-o/dyld.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  static const char suffix[] = "/../Resources/launcher.sh";
  char script[4096];
  uint32_t size = sizeof(script) - sizeof(suffix);
  // .../PKUNMUN2026.app/Contents/MacOS/PKUNMUN2026 → .../Contents/MacOS/../Resources/launcher.sh
  if (_NSGetExecutablePath(script, &size) != 0) return 1;
  char *slash = strrchr(script, '/');
  if (slash == NULL) return 1;
  memcpy(slash, suffix, sizeof(suffix));
  // bash 3.2 ships with every macOS; zsh is the fallback should a future release drop it.
  const char *shells[] = {"/bin/bash", "/bin/zsh"};
  for (int i = 0; i < 2; i++) {
    char *const argv[] = {(char *)shells[i], script, NULL};
    execv(shells[i], argv);
  }
  return 127;
}
