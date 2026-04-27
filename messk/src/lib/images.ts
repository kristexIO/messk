const MAX_AVATAR_DIMENSION = 512;
const AVATAR_QUALITY = 0.82;

export async function prepareAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to read the selected image.'));
      img.src = sourceUrl;
    });

    const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Avatar processing is not available in this browser.');
    }

    context.drawImage(image, 0, 0, width, height);

    const jpegDataUrl = canvas.toDataURL('image/jpeg', AVATAR_QUALITY);
    if (jpegDataUrl.length > 900_000) {
      return canvas.toDataURL('image/jpeg', 0.68);
    }
    return jpegDataUrl;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
