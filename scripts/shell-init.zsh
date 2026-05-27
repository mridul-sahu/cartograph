# Source from ~/.zshrc to enable Cartograph's gh auto-switch on cd.
#
# Adds a `chpwd` hook that, after every directory change, checks whether cwd
# is under cartograph/workspace/<repo>/ or cartograph/ proper and switches
# gh's active account to mridul-sahu or mridul-rudrite accordingly. Cached so
# the common case (cd within the same scope) is a no-op.
#
# Install:
#   echo 'source ~/rudrite/cartograph/scripts/shell-init.zsh' >> ~/.zshrc
#   exec zsh   # or open a new terminal

cartograph_gh_autoswitch() {
  # Delegate to the standalone script so the logic lives in one place
  # and is also usable from Claude Code hooks. Pass PWD explicitly to avoid
  # any pwd-resolution discrepancy.
  "$HOME/rudrite/cartograph/scripts/gh-autoswitch.sh" "$PWD" 2>/dev/null || true
}

if [[ -n "${ZSH_VERSION:-}" ]]; then
  autoload -U add-zsh-hook
  add-zsh-hook chpwd cartograph_gh_autoswitch
  # Run once at shell startup in case the initial PWD is already under cartograph.
  cartograph_gh_autoswitch
fi
