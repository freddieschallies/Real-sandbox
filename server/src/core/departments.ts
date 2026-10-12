// The departments a business usually has. A new company starts with the first five switched on
// (Admin is the office staff's);
// Refrigeration is there to switch on. HR or the CEO switches any of them off (a business without
// refrigeration, or that doesn't do electrical) and adds their own.
export const STANDARD_DEPARTMENTS: { name: string; startsOn: boolean }[] = [
  { name: 'Admin', startsOn: true },
  { name: 'Electrical', startsOn: true },
  { name: 'Plumbing', startsOn: true },
  { name: 'Service', startsOn: true },
  { name: 'Foodservice', startsOn: true },
  { name: 'Refrigeration', startsOn: false },
];
