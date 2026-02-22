import { UploadApiResponse, v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import logger from "../config/logger";

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const cloudinaryImageUpload = (
  imageBuffer: Buffer,
  folder?: string,
  resource_type?: "image" | "video" | "raw" | "auto"
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        ...(resource_type && { resource_type }),
      },
      (error, result) => {
        if (error) {
          logger.error({ err: error }, "Error uploading to Cloudinary");
          reject(error);
        } else {
          if (result) resolve(result);
        }
      }
    );

    const bufferStream = new Readable();
    bufferStream.push(imageBuffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
  });
};

export default cloudinary;
