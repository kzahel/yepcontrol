import { MediaError } from "@remote/client/control-session";

export class MediaCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaCliError";
  }
}
export function mediaFailure(error: unknown): MediaCliError {
  if (error instanceof MediaCliError) return error;
  if (error instanceof MediaError)
    return new MediaCliError(
      `MEDIA_${error.code.toUpperCase()}`,
      error.message,
    );
  if (error instanceof Error && error.name === "AbortError")
    return new MediaCliError("MEDIA_CANCELED", "Media capture was canceled.");
  return new MediaCliError(
    "MEDIA_INTERRUPTED",
    error instanceof Error ? error.message : "Media capture was interrupted.",
  );
}
export function outputFailure(error: unknown): MediaCliError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST")
    return new MediaCliError(
      "MEDIA_OUTPUT_EXISTS",
      "Output already exists. Choose a new path.",
    );
  if (code === "ENOSPC")
    return new MediaCliError(
      "MEDIA_OUTPUT_ERROR",
      "Not enough space for media output.",
    );
  return new MediaCliError(
    "MEDIA_OUTPUT_ERROR",
    "Could not save private media output.",
  );
}
