---
'@adonis-agora/media-dashboard': patch
'@adonis-agora/media': patch
---

The console's object preview shows Parquet files (`application/vnd.apache.parquet`, `application/x-parquet`, or a `.parquet` key) as a table: the schema with column types, the row count, and the first 50 rows. Files up to 25 MB preview inline; larger ones, or ones compressed with a codec other than Snappy, fall back to "Open original". The reader loads only when a Parquet file is opened.
