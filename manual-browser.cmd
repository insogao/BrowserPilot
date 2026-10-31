@echo off
rem Normal browsing mode for Browser CLI + BrowserPilot.
rem - Persistent profile (not a throwaway temp profile).
rem - No --browser-cli-background-presentation / --browser-cli-user-explicit-show.
rem - No --remote-debugging-port=0: Chromium turns that into navigator.webdriver=true.
rem - Dev build needs in-process GPU, and disabling DirectComposition to avoid the black DComp surface.
setlocal
set "CHROME=D:\c\src\out\WinDev\chrome.exe"
set "PROFILE=D:\work\BrowserPilot\.manual-profile-normal"
set "EXT=D:\work\BrowserPilot\dist"
start "" "%CHROME%" --user-data-dir="%PROFILE%" --load-extension="%EXT%" --in-process-gpu --disable-direct-composition --no-first-run --no-default-browser-check --disable-sync --disable-component-update --disable-background-networking https://www.baidu.com/
endlocal
