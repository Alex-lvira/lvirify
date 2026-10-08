# Showing the wall on a TV from the Pi

Chromium in kiosk mode, started at login (Raspberry Pi OS with desktop):

```sh
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/lvirify-kiosk.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=lvirify kiosk
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required http://localhost:3000/kiosk
DESKTOP
```

Keep the screen awake (`raspi-config` → Display → Screen Blanking → off), and
consider `unclutter` to hide the cursor if it ever shows.

The `/kiosk` route hides the header, fills the screen, and picks a grid size
from the number of connected people.
