ALTER TABLE interview_diary_batches ADD COLUMN origin text NOT NULL DEFAULT 'legacy' CHECK (origin IN ('legacy', 'import', 'journal'));
