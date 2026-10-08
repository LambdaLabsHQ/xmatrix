import { UserFacingProblem } from "../../lib/user-facing-error";
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new UserFacingProblem("This image couldn't be read."));
    image.src = src;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new UserFacingProblem("This image couldn't be compressed."));
        }
      },
      type,
      quality
    );
  });
}
