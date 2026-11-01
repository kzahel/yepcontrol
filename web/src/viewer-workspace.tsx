import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useClientSettings } from "./client-settings.js";

export const defaultScreenAspect = 1080 / 2400;

/** A shared frame keeps preview, connecting and live controls in the same place. */
export function ViewerWorkspace({
  children,
  controls,
  aspect = defaultScreenAspect,
}: {
  children: ReactNode;
  controls: ReactNode;
  aspect?: number;
}) {
  const { controlLabels } = useClientSettings();
  const element = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={element}
      className="viewer-workspace"
      data-labels={controlLabels || undefined}
      style={
        {
          "--screen-aspect": aspect,
          "--workspace-height":
            height === undefined ? undefined : `${height}px`,
        } as CSSProperties
      }
    >
      <div className="screen-stage">{children}</div>
      {controls}
    </div>
  );
}
