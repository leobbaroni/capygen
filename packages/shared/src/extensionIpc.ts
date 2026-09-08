import { z } from "zod";
import { ExtensionRegistrationSchema } from "./extensions.js";

const empty = z.object({}).strict();
const ok = z.object({ ok: z.boolean() });
const bounds = z.object({ x: z.number().int().min(0).max(32000), y: z.number().int().min(0).max(32000), width: z.number().int().min(1).max(16000), height: z.number().int().min(1).max(16000) }).strict();
export const ExtensionDescriptorSchema = ExtensionRegistrationSchema.extend({
  registrationId: z.string().uuid(), available: z.boolean(), reason: z.string().max(200).nullable(), name: z.string().max(200),
  pages: z.array(z.object({ id: z.string().max(200), title: z.string().max(200) })).max(32),
  navigation: z.array(z.object({ id: z.string().max(200), pageId: z.string().max(200), label: z.string().max(200) })).max(32),
});
export type ExtensionDescriptor = z.infer<typeof ExtensionDescriptorSchema>;
export const EXTENSION_INVOKE_CHANNELS = {
  "extensions.theme": { input: z.object({ tokens: z.record(z.string().max(100), z.string().max(256)).refine((value) => Object.keys(value).length <= 128) }).strict(), output: ok },
  "extensions.list": { input: z.object({ offset: z.number().int().min(0).max(64).default(0) }), output: z.object({ items: z.array(ExtensionDescriptorSchema).max(8), nextOffset: z.number().int().nullable() }) },
  "extensions.pick": { input: empty, output: z.string().max(4096).nullable() },
  "extensions.register": { input: ExtensionRegistrationSchema, output: ok },
  "extensions.unregister": { input: z.object({ registrationId: z.string().uuid() }).strict(), output: ok },
  "extensions.refresh": { input: empty, output: ok },
  "extensions.open": { input: z.object({ extensionId: z.string().max(200), pageId: z.string().max(200), bounds }).strict(), output: z.object({ instanceId: z.string().uuid() }) },
  "extensions.bounds": { input: z.object({ instanceId: z.string().uuid(), bounds }).strict(), output: ok },
  "extensions.close": { input: z.object({ instanceId: z.string().uuid() }).strict(), output: ok },
} as const;
export const EXTENSION_EVENT_CHANNELS = {
  "extensions.changed": empty,
  "extensions.navigate": z.object({ route: z.string().max(4096) }),
} as const;
