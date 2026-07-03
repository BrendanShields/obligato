-- SES-5: which runtime created the session row. Additive + nullable — rows
-- created before this migration read back null.
ALTER TABLE session ADD COLUMN runner TEXT CHECK (runner IN ('cc', 'native'));
