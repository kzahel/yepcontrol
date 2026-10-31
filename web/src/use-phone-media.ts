import { useEffect, useRef, useState } from "react";
import { CameraRenderer } from "./camera-renderer.js";
import type { RemoteSession } from "./control-session.js";
import { MediaReceiver, type SharingState } from "./media-receiver.js";
import { PhoneAudio } from "./phone-audio.js";

const off: SharingState = { phase: "off", message: "" };
export function usePhoneMedia(session: RemoteSession) {
  const [camera, setCamera] = useState(off);
  const [microphone, setMicrophone] = useState(off);
  const [aspect, setAspect] = useState(3 / 4);
  const receivers = useRef<
    | {
        session: RemoteSession;
        camera: MediaReceiver;
        microphone: MediaReceiver;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    let mounted = true;
    const current = {
      session,
      camera: new MediaReceiver((state) => mounted && setCamera(state)),
      microphone: new MediaReceiver((state) => mounted && setMicrophone(state)),
    };
    receivers.current = current;
    setCamera(off);
    setMicrophone(off);
    const stop = () => {
      const message =
        "Sharing stopped while this page was hidden. Start again to resume.";
      void current.camera.stop(message);
      void current.microphone.stop(message);
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stop);
      current.camera.close();
      current.microphone.close();
      if (receivers.current === current) receivers.current = undefined;
    };
  }, [session]);
  function startCamera(
    canvas: HTMLCanvasElement,
    facing: "front" | "rear",
    smooth: boolean,
  ) {
    const current = receivers.current;
    if (!current || current.camera.busy || document.hidden) return;
    const receiver = current.camera;
    try {
      const sink = new CameraRenderer(canvas, (width, height) => {
        setAspect((before) =>
          before === width / height ? before : width / height,
        );
        receiver.displayed();
      });
      receiver.start(
        (signal) =>
          current.session.startCamera({
            facing,
            format: smooth ? "h264" : "jpeg",
            fps: smooth ? 15 : 2,
            signal,
          }),
        sink,
      );
    } catch (error) {
      setCamera({
        phase: "off",
        message: error instanceof Error ? error.message : "Camera unavailable",
      });
    }
  }
  function listen() {
    const current = receivers.current;
    if (!current || current.microphone.busy || document.hidden) return;
    const receiver = current.microphone;
    try {
      const audio = new PhoneAudio(
        () => receiver.displayed(),
        () =>
          void receiver.stop(
            "Audio playback paused. Choose Listen to start again.",
          ),
      );
      // resume() is called synchronously in the deliberate click's activation scope.
      receiver.start(
        (signal) => current.session.startMicrophone({ signal }),
        audio,
        audio.resume(),
      );
    } catch (error) {
      setMicrophone({
        phase: "off",
        message:
          error instanceof Error ? error.message : "Audio playback unavailable",
      });
    }
  }
  return {
    camera,
    microphone,
    aspect,
    startCamera,
    listen,
    stopCamera: () => receivers.current?.camera.stop() ?? Promise.resolve(),
    stopMicrophone: () =>
      receivers.current?.microphone.stop() ?? Promise.resolve(),
  };
}
