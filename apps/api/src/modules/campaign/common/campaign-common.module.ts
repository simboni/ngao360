import { Module } from '@nestjs/common';

/**
 * Shared campaign helpers are plain functions (./campaign-scope,
 * ./campaign-support); this module exists so sub-modules can add shared
 * providers later without touching each other.
 */
@Module({})
export class CampaignCommonModule {}
