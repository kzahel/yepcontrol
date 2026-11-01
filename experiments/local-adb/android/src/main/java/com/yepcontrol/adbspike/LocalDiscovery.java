package com.yepcontrol.adbspike;

import android.content.Context;
import android.net.nsd.*;
import java.net.*;
import java.util.concurrent.*;

/** Discover a listener on this device only. Never dial a LAN peer from mDNS. */
final class LocalDiscovery implements AutoCloseable {
    final NsdManager nsd;
    final BlockingQueue<Integer> ports = new LinkedBlockingQueue<>();
    final NsdManager.DiscoveryListener listener;
    LocalDiscovery(Context context, String type) {
        nsd = context.getSystemService(NsdManager.class);
        listener = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String t) {}
            public void onDiscoveryStopped(String t) {}
            public void onStartDiscoveryFailed(String t, int e) {}
            public void onStopDiscoveryFailed(String t, int e) {}
            public void onServiceLost(NsdServiceInfo i) {}
            public void onServiceFound(NsdServiceInfo i) {
                nsd.resolveService(i, new NsdManager.ResolveListener() {
                    public void onResolveFailed(NsdServiceInfo i, int e) {}
                    public void onServiceResolved(NsdServiceInfo i) {
                        try {
                            InetAddress host = i.getHost();
                            if (host != null && (host.isLoopbackAddress() || NetworkInterface.getByInetAddress(host) != null)) ports.offer(i.getPort());
                        } catch (Exception ignored) {}
                    }
                });
            }
        };
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
    }
    int await(long seconds) throws Exception {
        Integer p = ports.poll(seconds, TimeUnit.SECONDS);
        if (p == null) throw new TimeoutException("Local wireless listener not discovered");
        return p;
    }
    public void close() { try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) {} }
}
