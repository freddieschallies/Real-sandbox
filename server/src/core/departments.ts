// The departments a business usually has. A new company starts with all of them (Admin is the office
// staff's); HR or the CEO switches off any the business doesn't do and adds their own.
export const STANDARD_DEPARTMENTS: { name: string; startsOn: boolean }[] = [
  { name: 'Admin', startsOn: true },
  { name: 'Electrical', startsOn: true },
  { name: 'Plumbing', startsOn: true },
  { name: 'Service', startsOn: true },
  { name: 'Foodservice', startsOn: true },
];
