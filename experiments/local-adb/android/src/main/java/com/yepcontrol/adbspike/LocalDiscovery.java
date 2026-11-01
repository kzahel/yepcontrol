package com.yepcontrol.adbspike;

import android.content.Context;
import android.net.nsd.*;
import android.os.Handler;
import android.os.Looper;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** Discover a listener on this device only. Never dial a LAN peer from mDNS. */
final class LocalDiscovery implements AutoCloseable {
    final NsdManager nsd;
    final Handler callbacks = new Handler(Looper.getMainLooper());
    final BlockingQueue<Integer> ports = new LinkedBlockingQueue<>();
    final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    final Map<String, Integer> attempts = new HashMap<>();
    final NsdManager.DiscoveryListener listener;
    volatile boolean closed;
    boolean resolving;
    LocalDiscovery(Context context, String type) {
        nsd = context.getSystemService(NsdManager.class);
        listener = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String t) {
                if (closed) { stopDiscovery(); return; }
                android.util.Log.d("LocalAdbDiscovery", "started " + type);
            }
            public void onDiscoveryStopped(String t) {}
            public void onStartDiscoveryFailed(String t, int e) { android.util.Log.d("LocalAdbDiscovery", "start failed " + e); }
            public void onStopDiscoveryFailed(String t, int e) {}
            public void onServiceLost(NsdServiceInfo i) {}
            public void onServiceFound(NsdServiceInfo i) {
                callbacks.post(() -> {
                    if (closed || attempts.containsKey(i.getServiceName()) || attempts.size() >= 64) return;
                    attempts.put(i.getServiceName(), 0); pending.offer(i); resolveNext();
                });
            }
        };
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
    }
    void resolveNext() {
        if (closed || resolving || pending.isEmpty()) return;
        NsdServiceInfo service = pending.remove(); resolving = true;
        attempts.put(service.getServiceName(), attempts.get(service.getServiceName()) + 1);
        // Older NsdManager permits only one outstanding resolution, including foreign
        // LAN advertisements. Dropping FAILURE_ALREADY_ACTIVE can lose our own listener.
        try {
            nsd.resolveService(service, new NsdManager.ResolveListener() {
                public void onResolveFailed(NsdServiceInfo i, int error) {
                    callbacks.post(() -> {
                        if (closed) return;
                        resolving = false;
                        android.util.Log.d("LocalAdbDiscovery", "resolve failed " + error);
                        if (attempts.get(service.getServiceName()) < 3) callbacks.postDelayed(() -> {
                            if (!closed) { pending.offer(service); resolveNext(); }
                        }, 1000);
                        resolveNext();
                    });
                }
                public void onServiceResolved(NsdServiceInfo info) {
                    callbacks.post(() -> {
                        if (closed) return;
                        resolving = false;
                        try {
                            InetAddress host = info.getHost();
                            boolean local = host != null && (host.isLoopbackAddress() || NetworkInterface.getByInetAddress(host) != null);
                            android.util.Log.d("LocalAdbDiscovery", "resolved local=" + local);
                            if (local && info.getPort() > 0 && info.getPort() <= 65535) ports.offer(info.getPort());
                        } catch (Exception ignored) { android.util.Log.d("LocalAdbDiscovery", "local address check failed"); }
                        resolveNext();
                    });
                }
            });
        } catch (RuntimeException error) {
            resolving = false;
            android.util.Log.d("LocalAdbDiscovery", "resolve request rejected");
            resolveNext();
        }
    }
    int await(long seconds) throws Exception {
        Integer p = ports.poll(seconds, TimeUnit.SECONDS);
        if (p == null) throw new TimeoutException("Local wireless listener not discovered");
        return p;
    }
    void stopDiscovery() { try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) {} }
    public void close() { closed = true; callbacks.removeCallbacksAndMessages(null); stopDiscovery(); }
}
