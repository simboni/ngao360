import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { LocalStorageDriver } from './drivers/local.driver';
import { StorageService } from './storage.service';
import { STORAGE_DRIVER, type StorageDriver } from './storage.types';

/**
 * Serves local-driver signed URLs (development/tests). The HMAC token was issued
 * by StorageService.signedUrl() after a permission check + audit, and expires quickly.
 */
@Controller('files')
export class FilesController {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get('local/:token')
  async local(@Param('token') token: string, @Res() res: Response): Promise<void> {
    if (!(this.driver instanceof LocalStorageDriver)) throw new NotFoundException();
    const payload = this.driver.verifyToken(token);
    if (!payload) throw new NotFoundException();
    // A link issued before the file was quarantined stops working at once.
    if (await this.storage.isQuarantined(payload.k)) throw new NotFoundException();
    const body = await this.driver.get(payload.k);
    res.setHeader('Content-Type', payload.m ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const name = (payload.f ?? 'file').replace(/[^\w.\- ]/g, '_');
    res.setHeader('Content-Disposition', `${payload.d ?? 'inline'}; filename="${name}"`);
    res.send(body);
  }
}
