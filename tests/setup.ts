// Global test setup — runs before all test files
process.env.DATABASE_URL = "file:./data/cramkit-test.db";
process.env.LLM_BASE_URL = "http://localhost:3456/v1";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "claude-opus-4-6";
process.env.CRAMKIT_API_URL = "http://localhost:8787";
