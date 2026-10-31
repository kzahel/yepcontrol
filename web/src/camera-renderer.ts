import type { MediaPacket } from "@remote/protocol/media";
import type { MediaSink } from "./media-receiver.js";
import { VideoDecodeError, VideoRenderer } from "./video-renderer.js";

/** Camera pixels never enter the screen input canvas or React state. */
export class CameraRenderer implements MediaSink {
  private closed = false;
  private readonly video: VideoRenderer;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly displayed: (width: number, height: number) => void,
  ) {
    this.video = new VideoRenderer(canvas, (frame) =>
      displayed(frame.width, frame.height),
    );
  }
  async push(packet: MediaPacket) {
    if (this.closed) return;
    if (packet.kind === "jpeg") {
      const image = await createImageBitmap(
        new Blob([packet.data], { type: "image/jpeg" }),
      );
      try {
        if (this.closed) return;
        if (image.width !== packet.width || image.height !== packet.height)
          throw new Error("Camera frame dimensions disagree");
        this.canvas.width = image.width;
        this.canvas.height = image.height;
        this.canvas.getContext("2d")?.drawImage(image, 0, 0);
        this.displayed(image.width, image.height);
      } finally {
        image.close();
      }
    } else if (packet.kind === "h264") {
      try {
        this.video.push({
          id: 1,
          kind: "video",
          epoch: packet.stream,
          scene: 1,
          width: packet.width,
          height: packet.height,
          sourceWidth: packet.width,
          sourceHeight: packet.height,
          timestamp: packet.timestamp,
          key: packet.key,
          data: packet.data,
        });
      } catch (error) {
        if (error instanceof VideoDecodeError)
          throw new Error(
            "Live camera video is unavailable. Choose Still frames, then Start camera.",
          );
        throw error;
      }
    } else throw new Error("Unexpected camera format");
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.video.close();
    this.canvas
      .getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
