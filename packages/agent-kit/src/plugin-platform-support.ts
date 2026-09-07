export const PLUGIN_WINDOWS_SUPPORT = {
  supportedShell: 'WSL2 Ubuntu Bash',
  unsupportedShells: 'PowerShell, Command Prompt, and Git Bash',
  installCommand: 'wsl --install -d Ubuntu',
} as const;

export const PLUGIN_UNSUPPORTED_NATIVE_WINDOWS = {
  code: 'unsupported_platform',
  message: 'Noodle CLI commands run on macOS or Windows through WSL2.',
  cause: `Native ${PLUGIN_WINDOWS_SUPPORT.unsupportedShells} are not supported.`,
  fix: 'Install WSL2 with Ubuntu and run Noodle from its Bash shell.',
  next: PLUGIN_WINDOWS_SUPPORT.installCommand,
} as const;
