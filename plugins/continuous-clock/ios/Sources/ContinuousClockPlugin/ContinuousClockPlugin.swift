import Foundation
import Capacitor

/**
 * mach_continuous_time() advances while the device is asleep; mach_absolute_time() — and
 * therefore performance.now() in the WebView — does not. See spec §3.3 / §3.4.
 *
 * Not yet compiled: written in a Linux cloud session with no Xcode.
 */
@objc(ContinuousClockPlugin)
public class ContinuousClockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ContinuousClockPlugin"
    public let jsName = "ContinuousClock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise)
    ]

    /// Ticks-to-nanoseconds ratio. Constant for the life of the process, so read it once.
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    @objc func now(_ call: CAPPluginCall) {
        let ticks = mach_continuous_time()
        let info = ContinuousClockPlugin.timebase
        // numer/denom is 1/1 on current arm64, but multiplying first keeps this correct
        // on any device where it is not.
        let ns = ticks * UInt64(info.numer) / UInt64(info.denom)
        // JS numbers are exact to 2^53 ns, which is ~104 days of uptime. Beyond that this
        // loses precision; a device up that long is not a case this tool needs to serve.
        call.resolve(["ns": Double(ns)])
    }
}
