# WTF is this?
A Latest Files Announcement mod for [ENiGMA½](https://github.com/NuSkooler/enigma-bbs)! Slap this mod in your ENiGMA½ event scheduler to announce your latest super l337 warez!

# Installation
## Step 1
If you're on a *nix os, run `install.sh`. If you're on Windows, copy the `latest_files_announce_evt` dir to `$ENIGMA_PATH/mods/`.

## Step 2
Create a schedule. Specify _1:n_ message area tags to post announcements to in `args`. For example:

```
eventScheduler: {
  events: {
    latestFilesAnnounceEvent: {
      schedule: at 3:30 am
      action: @method:mods/latest_files_announce_evt/latest_files_announce_evt.js:latestFilesAnnounceEvent
      args: [ "fsx_bot,agn_ads" ]
    }
  }
}
```

Note that the **first run** sets the "since" timestamp.

# Tweaking Things
Modify the `options.hjson` as you please as well as edit the contents of the `LFA*.ASC` files to change the look of your announcements.

ASCii files can use the following format keys:
```
{boardName}
{nowTs}
{sinceTs}	
{areaFileCount}
{areaRemainingFiles}
{areaFileBytes}
{totalFileCount}
{totalFileBytes}
{areaName}
{areaDesc}
{fileName}
{fileSize}
{fileDesc}
{fileSha256}
{fileCrc32}
{fileMd5}
{fileSha1}
{uploadBy}
{fileUploadTs}
{fileHashTags}
```

# License
[LICENSE](LICENSE)