import Uppy from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import { useRequestUploadUrl } from '@workspace/api-client-react';

/** Direct-to-storage upload using Uppy; only metadata passes through the application API. */
export function usePhotoUpload() {
  const request = useRequestUploadUrl();
  const uploadPhoto = async (file: File): Promise<string> => {
    let objectPath = '';
    const uppy = new Uppy({ autoProceed: false, restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ['image/*'] } });
    uppy.use(AwsS3, {
      shouldUseMultipart: false,
      getUploadParameters: async (uppyFile) => {
        const signed = await request.mutateAsync({ data: {
          name: uppyFile.name,
          size: uppyFile.size || file.size,
          contentType: uppyFile.type || file.type,
        } });
        objectPath = signed.objectPath;
        return {
          method: 'PUT',
          url: signed.uploadURL,
          headers: { 'Content-Type': uppyFile.type || file.type },
        };
      },
    });
    try {
      uppy.addFile({ name: file.name, type: file.type, data: file });
      const result = await uppy.upload();
      if (result?.failed?.length || !result?.successful?.length || !objectPath) throw new Error('تعذّر رفع الصورة');
      return objectPath;
    } finally {
      uppy.destroy();
    }
  };
  return { uploadPhoto };
}