import type { Page } from "@playwright/test";

/** Test-only observer: actual audio graph output, canvas draws and local permission requests. */
export async function observeMediaBrowser(page: Page) {
  await page.addInitScript({
    content: `
    window.mediaBrowserEvidence = { contexts: [], analysers: [], played: 0, drawn: 0, localRequests: 0, maxAhead: 0, clockTicks: 0, renewTicks: 0, destinationConnections: 0 };
    const evidence = window.mediaBrowserEvidence;
    const interval = window.setInterval.bind(window);
    interval(() => evidence.clockTicks++, 100);
    window.setInterval = (handler, delay, ...args) => {
      if (delay !== 5000 || typeof handler !== 'function') return interval(handler, delay, ...args);
      return interval(() => { evidence.renewTicks++; handler(...args); }, delay);
    };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
      evidence.localRequests++;
      return Promise.reject(new Error('Local capture must not be requested'));
    };
    const BaseAudioContext = window.AudioContext;
    window.AudioContext = class extends BaseAudioContext {
      constructor(options) {
        super(options);
        evidence.contexts.push(this);
        this.proofAnalyser = this.createAnalyser();
        this.proofAnalyser.connect(this.destination);
        evidence.analysers.push(this.proofAnalyser);
      }
      createBufferSource() {
        const source = super.createBufferSource();
        const connect = source.connect.bind(source);
        source.connect = (target, ...args) => {
          if (target === this.destination) {
            evidence.destinationConnections++;
            connect(this.proofAnalyser, ...args);
            return target;
          }
          return connect(target, ...args);
        };
        const start = source.start.bind(source);
        source.start = (when = 0, ...args) => {
          evidence.maxAhead = Math.max(evidence.maxAhead, when - this.currentTime + (source.buffer?.duration || 0));
          return start(when, ...args);
        };
        source.addEventListener('ended', () => evidence.played++);
        return source;
      }
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
      const result = draw.apply(this, args);
      if (this.canvas.getAttribute('aria-label') === 'Phone camera preview') evidence.drawn++;
      return result;
    };
  `,
  });
}

export async function mediaBrowserEvidence(page: Page) {
  return page.evaluate(() => {
    const value = window.mediaBrowserEvidence;
    let peak = 0;
    for (const [index, analyser] of value.analysers.entries()) {
      if (value.contexts[index]?.state !== "running") continue;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
    return {
      peak,
      played: value.played,
      drawn: value.drawn,
      localRequests: value.localRequests,
      contexts: value.contexts.map((context) => context.state),
      maxAhead: value.maxAhead,
      clockTicks: value.clockTicks,
      renewTicks: value.renewTicks,
      destinationConnections: value.destinationConnections,
    };
  });
}
declare global {
  interface Window {
    mediaBrowserEvidence: {
      contexts: AudioContext[];
      analysers: AnalyserNode[];
      played: number;
      drawn: number;
      localRequests: number;
      maxAhead: number;
      clockTicks: number;
      renewTicks: number;
      destinationConnections: number;
    };
  }
}
