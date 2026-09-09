#!/bin/bash

# 1. Change Hostname
sudo hostname "alphardp"
echo "alphardp" | sudo tee /etc/hostname >/dev/null
echo "127.0.0.1 alphardp" | sudo tee -a /etc/hosts >/dev/null

# 2. Clear MOTD (Welcome Message)
sudo rm -f /etc/motd
sudo touch /etc/motd
sudo chmod -x /etc/update-motd.d/* 2>/dev/null || true

# 2b. Set AlphaRDP Wallpaper (downloads from remote URL)
wget -q "https://i.ibb.co/nqP0qbDY/alphardp-wallpaper-1788939749765.jpg" -O /usr/share/backgrounds/alphardp-wallpaper.jpg 2>/dev/null || true
if [ -f /usr/share/backgrounds/alphardp-wallpaper.jpg ]; then
    DISPLAY=:10.0 xfconf-query -c xfce4-desktop \
      -p /backdrop/screen0/monitorrdp0/workspace0/last-image \
      -s /usr/share/backgrounds/alphardp-wallpaper.jpg \
      --create -t string 2>/dev/null || true
    DISPLAY=:10.0 xfconf-query -c xfce4-desktop \
      -p /backdrop/screen0/monitorrdp0/workspace0/image-style \
      -s 4 --create -t int 2>/dev/null || true
fi

# 3. Change display name (Fixes the top-right XFCE panel)
# This changes the "Full Name" of the account to "gihan" without breaking the system
sudo usermod -c "gihan" codespace 2>/dev/null

# --- PHASE 1, 2 & 3 BRANDING & DASHBOARD ---

# Phase 1: Terminal Branding (Neofetch)
if ! command -v neofetch >/dev/null 2>&1; then
    sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y neofetch >/dev/null 2>&1
fi

# Create a custom Neofetch logo for AlphaRDP
mkdir -p ~/.config/neofetch
cat << 'EOF' > ~/.config/neofetch/alphardp_logo.txt
${c1}    ___   __      __        ____  ___  ___ 
   / _ | / /___  / /  ___  / _ \/ _ \/ _ \
  / __ |/ / / _ \/ _ \/ _ `/ , _/ // / ___/
 /_/ |_/_/ / .__/_//_/\_,_/_/|_/____/_/    
          /_/                              
EOF

# Phase 2: XRDP Login Screen Customization
if [ -f /etc/xrdp/xrdp.ini ]; then
    sudo sed -i 's/.*ls_title.*/ls_title=AlphaRDP Secure Login/g' /etc/xrdp/xrdp.ini
    sudo sed -i 's/.*ls_top_window_bg_color.*/ls_top_window_bg_color=000000/g' /etc/xrdp/xrdp.ini
    sudo sed -i 's/.*ls_bg_color.*/ls_bg_color=0a1a0a/g' /etc/xrdp/xrdp.ini
    sudo sed -i 's/.*ls_logo_filename.*/ls_logo_filename=/g' /etc/xrdp/xrdp.ini
    sudo /etc/init.d/xrdp restart >/dev/null 2>&1 || true
fi

# Phase 3: System Dashboard (Glances)
if ! command -v glances >/dev/null 2>&1; then
    sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y glances >/dev/null 2>&1
fi
# Kill any existing glances web server and start a fresh one in the background
pkill -f 'glances -w' || true
nohup glances -w >/dev/null 2>&1 &

# 4. Aggressive Bashrc Override (Fixes the terminal prompt & path)
# Remove old cloaking if it exists
sed -i '/# --- CLOAKING ---/,/# ----------------/d' ~/.bashrc

cat << 'EOF' >> ~/.bashrc
# --- CLOAKING ---
# Kill the default GitHub custom prompt script
unset PROMPT_COMMAND

# Set a standard, generic Linux prompt
export PS1='\[\e]0;gihan@alphardp: \w\a\]\[\033[01;32m\]gihan@alphardp\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

# Wipe GitHub variables
unset CODESPACES CODESPACE_NAME GITHUB_USER GITHUB_TOKEN GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN GITHUB_API_URL GITHUB_GRAPHQL_URL GITHUB_REPOSITORY GITHUB_SERVER_URL INTERNAL_DEVCONTAINER_COMMAND DEVCONTAINER

# Pretend we are gihan
export USER=gihan
export LOGNAME=gihan

# Run custom AlphaRDP Neofetch on startup
# We run it manually to guarantee it prints
neofetch --ascii ~/.config/neofetch/alphardp_logo.txt --ascii_colors 4 4 --title_fqdn off || true

# Start in home directory instead of /workspaces/...
if [[ "$PWD" == "/workspaces/"* ]]; then
    cd ~
fi

# Fake the uninstallation of GitHub CLI
alias gh='echo bash: gh: command not found'
# ----------------
EOF

# 5. Apply to ZSH just in case they open a zsh terminal
if [ -f ~/.zshrc ]; then
    sed -i '/# --- CLOAKING ---/,/# ----------------/d' ~/.zshrc
    cat << 'EOF' >> ~/.zshrc
# --- CLOAKING ---
export PROMPT='%F{green}gihan@alphardp%f:%F{blue}%~%f$ '
unset CODESPACES CODESPACE_NAME GITHUB_USER GITHUB_TOKEN
export USER=gihan
if [[ "$PWD" == "/workspaces/"* ]]; then cd ~; fi
alias gh='echo zsh: command not found: gh'
# ----------------
EOF
fi

# 6. Restart XFCE panel so it immediately updates the top-right text
pkill xfce4-panel || true
