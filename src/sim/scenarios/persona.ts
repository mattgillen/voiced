// The demo user. Every name, number and business in the simulator is fictional
// (555-01xx numbers are reserved for fiction; cards are public test numbers).

export interface Card {
  id: string;
  label: string;
  number: string;
  exp: string;
  cvvLength: number;
  last4: string;
}

export const persona = {
  name: 'Jordan Lee',
  firstName: 'Jordan',
  mobile: '4155550142',
  mobileDisplay: '(415) 555-0142',
  address: '320 Sycamore Street',
  city: 'Bedford Falls',
  zip: '13205',
  cards: [
    { id: 'visa', label: 'Visa •• 4242', number: '4242424242424242', exp: '1228', cvvLength: 3, last4: '4242' },
    { id: 'amex', label: 'Amex •• 0005', number: '378282246310005', exp: '0927', cvvLength: 4, last4: '0005' },
  ] satisfies Card[],
};

export function card(id: string | undefined): Card {
  return persona.cards.find((c) => c.id === id) ?? persona.cards[0];
}
