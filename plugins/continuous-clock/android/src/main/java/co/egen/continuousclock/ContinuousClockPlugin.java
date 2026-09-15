package co.egen.continuousclock;

import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SystemClock.elapsedRealtimeNanos() counts nanoseconds since boot INCLUDING deep sleep.
 * System.nanoTime() and performance.now() in the WebView both pause. See spec §3.3 / §3.4.
 *
 * Not yet compiled: written in a Linux cloud session with no Android SDK.
 */
@CapacitorPlugin(name = "ContinuousClock")
public class ContinuousClockPlugin extends Plugin {

    @PluginMethod
    public void now(PluginCall call) {
        JSObject result = new JSObject();
        // JS numbers are exact to 2^53 ns (~104 days of uptime); past that this loses
        // precision, which is not a case this tool needs to serve.
        result.put("ns", (double) SystemClock.elapsedRealtimeNanos());
        call.resolve(result);
    }
}
