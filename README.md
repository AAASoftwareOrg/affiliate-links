# Hometaskly Affiliate Links

This repository contains the affiliate-link data used by Hometaskly.

## Validate Amazon links

Run the validator from this directory:

```bash
npm run validate:amazon
```

The script reads `affiliate-links.json`, follows each unique Amazon link, and reports:

- `PASS`: the product page has an Add to Cart or Buy Now control.
- `FAIL`: Amazon says the product is unavailable or the page does not exist.
- `UNKNOWN`: availability could not be confirmed, such as when Amazon returns a CAPTCHA, an HTTP error, or a page without a purchase control.

At the end, the script prints separate summaries for unavailable and unverifiable links, including their locations in the JSON file. It exits with status `0` only when every link passes.

Amazon may temporarily return CAPTCHA pages when many links are checked. If that happens, wait before running the validator again. To reduce request concurrency, run:

```bash
npm run validate:amazon -- --concurrency 1
```

For machine-readable output:

```bash
npm run validate:amazon -- --json
```

Other options are available with:

```bash
npm run validate:amazon -- --help
```

## Run tests

```bash
npm test
```
