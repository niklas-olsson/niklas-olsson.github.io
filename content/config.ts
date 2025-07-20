import { defineCollection, z } from 'astro:content';

const insightsCollection = defineCollection({
  type: 'content', // v2.5.0 and later
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()).optional(), // New tags field
  }),
});

export const collections = {
  'insights': insightsCollection,
};