import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';
import { isZodDto } from './zod-dto';

/**
 * Global pipe: validates/transforms arguments whose type is a createZodDto class.
 * Non-zod arguments pass through unchanged. Use `new ZodPipe(schema)` for ad-hoc
 * validation, e.g. `@Param(new ZodPipe(IdParamSchema)) p: IdParam`.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'custom') return value;
    if (isZodDto(metadata.metatype)) return metadata.metatype.zodSchema.parse(value);
    return value;
  }
}

@Injectable()
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): unknown {
    return this.schema.parse(value);
  }
}
