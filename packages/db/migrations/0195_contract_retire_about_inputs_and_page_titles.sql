-- Channel About Runs are retired (#533, #537): a conversation's About is a text
-- task that records no input, so nothing reads or writes
-- data.channel_about_inputs, whose rows already went with their Channel. A
-- page's name is the heading its document opens with (#527, 0192, 0193):
-- nothing reads or writes data.pages.title any more.

SET LOCAL lock_timeout = '5s';

DROP TABLE data.channel_about_inputs;
ALTER TABLE data.pages DROP COLUMN title;
