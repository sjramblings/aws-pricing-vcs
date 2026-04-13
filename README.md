# aws-pricing-vcs

Fetch AWS service pricing from the AWS Pricing API and ingest it into Viking Context Service (VCS) as searchable L0/L1/L2 context for LLM cost modelling.

Bedrock is the first supported service; the pipeline is built around a pluggable `Fetcher` interface so any service with public Pricing API data can be added with a single new file.

See the open PR for the initial implementation.
