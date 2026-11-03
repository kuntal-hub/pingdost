// swift-tools-version:5.9
// The platform-independent core of the iOS nearby module (framing, links, policy, inbound
// queue), built and tested on its own so it runs on Linux without Xcode (Phase 30, ADR 0033):
//   docker run --rm -v "${PWD}/apps/mobile/modules/nearby/ios:/pkg" -w /pkg swift:6.4.2-noble swift test
// CocoaPods ignores this file; the podspec compiles Core/ together with the CoreBluetooth code.
import PackageDescription

let package = Package(
  name: "NearbyCore",
  targets: [
    .target(name: "NearbyCore", path: "Core"),
    .testTarget(name: "NearbyCoreTests", dependencies: ["NearbyCore"], path: "Tests"),
  ]
)
