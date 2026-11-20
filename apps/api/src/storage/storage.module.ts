import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { LocalStorageDriver } from './drivers/local.driver';
import { S3StorageDriver } from './drivers/s3.driver';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';
import { STORAGE_DRIVER, type StorageDriver } from './storage.types';

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: STORAGE_DRIVER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): StorageDriver => {
        const v = config.values;
        if (v.STORAGE_DRIVER === 's3') {
          return new S3StorageDriver({
            endpoint: v.S3_ENDPOINT,
            region: v.S3_REGION,
            bucket: v.S3_BUCKET,
            accessKeyId: v.S3_ACCESS_KEY_ID,
            secretAccessKey: v.S3_SECRET_ACCESS_KEY,
            forcePathStyle: v.S3_FORCE_PATH_STYLE,
          });
        }
        return new LocalStorageDriver(v.STORAGE_LOCAL_ROOT, `${v.JWT_ACCESS_SECRET}:storage`);
      },
    },
    StorageService,
  ],
  exports: [StorageService, STORAGE_DRIVER],
})
export class StorageModule {}
