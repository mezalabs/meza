# Publishing Checklist

Steps to publish Meza desktop to AUR after merging PR #62.

## Prerequisites

- [ ] PR #62 merged to main
- [ ] A desktop release exists on GitHub (e.g. `desktop-v0.0.7`) with the artifact:
  - `Meza-X.Y.Z-linux-x86_64.AppImage`

## AUR

- [ ] Create an account at https://aur.archlinux.org
- [ ] Add your SSH public key to your AUR account settings
- [ ] Clone the AUR repo:
  ```bash
  git clone ssh://aur@aur.archlinux.org/meza-desktop-bin.git
  ```
- [ ] Copy packaging files into the AUR repo:
  ```bash
  cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO meza-desktop-bin/
  ```
- [ ] Test locally before pushing:
  ```bash
  cd meza-desktop-bin && makepkg -si
  ```
- [ ] Verify the installed app launches: run `meza` from terminal
- [ ] Commit and push to AUR:
  ```bash
  git add PKGBUILD .SRCINFO
  git commit -m "Initial upload: meza-desktop-bin 0.0.7"
  git push
  ```
- [ ] Verify the package appears at https://aur.archlinux.org/packages/meza-desktop-bin

## Future Releases

When cutting a new desktop release, the full flow is:

```bash
task release:desktop -- X.Y.Z        # bump version, commit, tag
git push && git push --tags           # triggers CI build
# wait for CI to upload artifacts...
task release:desktop:update-packaging -- X.Y.Z  # update checksums
# then copy updated files to AUR repo and push
```
