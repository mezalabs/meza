cask "meza" do
  version "0.0.7"

  on_arm do
    sha256 "87b440961b683c1373a19b89b859f75dd469527b6c9936b016e0b867e97e01ae"
    url "https://github.com/mezalabs/meza/releases/download/desktop-v#{version}/Meza-#{version}-mac-arm64.zip"
  end

  on_intel do
    sha256 "327805988e193a4f89f37a9d07d47fa659c6dc44cf8753b326f3bc89962bdb64"
    url "https://github.com/mezalabs/meza/releases/download/desktop-v#{version}/Meza-#{version}-mac-x64.zip"
  end

  name "Meza"
  desc "Real-time encrypted chat"
  homepage "https://meza.chat"

  livecheck do
    url "https://github.com/mezalabs/meza/releases"
    strategy :github_latest
    regex(/desktop[._-]v?(\d+(?:\.\d+)+)/i)
  end

  app "Meza.app"

  zap trash: [
    "~/Library/Application Support/Meza",
    "~/Library/Preferences/com.meza.desktop.plist",
    "~/Library/Saved Application State/com.meza.desktop.savedState",
  ]
end
