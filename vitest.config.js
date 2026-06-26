import { defineConfig } from 'vitest/config';

// Vitest runs the pure logic modules (money/VAT/mileage maths). Node environment
// is enough — these tests don't touch the DOM or Supabase.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
});
