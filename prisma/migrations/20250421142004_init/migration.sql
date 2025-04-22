-- CreateTable
CREATE TABLE "GeminiResponse" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "GeminiResponse_pkey" PRIMARY KEY ("id")
);
