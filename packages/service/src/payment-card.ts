/** Payment card detection shared by payload validation and conversation capture. */
const CARD_CANDIDATE = /(?:\d[ -]?){13,19}/g;

export function looksLikePaymentCard(value: string): boolean {
  const candidates = value.match(CARD_CANDIDATE) ?? [];
  return candidates.some((candidate) => isCardNumber(candidate.replace(/\D/g, '')));
}

/** Keeps only the last four digits of each checksum-valid card number (ADR 0241 decision 15). */
export function maskPaymentCards(value: string): string {
  return value.replace(CARD_CANDIDATE, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (!isCardNumber(digits)) return candidate;
    return `•••• ${digits.slice(-4)}${/[ -]$/.test(candidate) ? candidate.slice(-1) : ''}`;
  });
}

function isCardNumber(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
