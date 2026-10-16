/**
 * Ordinary payments an older adult might ask her assistant to make, worded the
 * way an assistant might pass them on. None of them may ever be stopped: a
 * false stop has no family override, so it would keep her from paying a real
 * bill. `verdict` is what Hold On answers today with the default settings and
 * no confirmed payees, so any change in what these requests get is noticed.
 */
import type { CheckInput, Verdict } from '../src/domain/types.js';

export interface OrdinaryRequest {
  input: CheckInput;
  verdict: Exclude<Verdict, 'stop'>;
}

export const ORDINARY_REQUESTS: OrdinaryRequest[] = [
  // Bills and utilities
  { verdict: 'verified', input: { description: 'My Con Edison electric bill came in the mail. It is $182.40. Please pay it with my card.', payee_name: 'Con Edison', amount_usd: 182.4, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my water bill to the City of Springfield Water Department, $64.20, from my bank account.', payee_name: 'City of Springfield Water Department', amount_usd: 64.2, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'My Georgia Power bill is $143.18 and the autopay did not go through. Pay it with my debit card.', payee_name: 'Georgia Power', amount_usd: 143.18, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'The gas bill from Atmos Energy is $58.77. I would like to pay it by check.', payee_name: 'Atmos Energy', amount_usd: 58.77, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay the Jackson Rural Electric bill, $97.12, from my checking account.', payee_name: 'Jackson Rural Electric', amount_usd: 97.12, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay Comcast for the internet and cable, $129.99, on my card.', payee_name: 'Comcast', amount_usd: 129.99, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Pay my Verizon phone bill. It is $85.40 this month.', payee_name: 'Verizon', amount_usd: 85.4, contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Send Waste Management the $32 for the quarterly trash pickup by check.', payee_name: 'Waste Management', amount_usd: 32, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'verified', input: { description: 'The Duke Energy bill is $211.55. Pay it with my Visa.', payee_name: 'Duke Energy', amount_usd: 211.55, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'verified', input: { description: 'The PG&E bill is $76.10. Please pay it from my checking account.', payee_name: 'PG&E', amount_usd: 76.1, payment_method: 'bank_transfer', contact_channel: 'mail' } },

  // Groceries and shopping
  { verdict: 'unknown', input: { description: 'Order my groceries from Kroger for delivery, about $87, with my Visa.', payee_name: 'Kroger', amount_usd: 87, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Pay for the Instacart grocery order, $64.35.', payee_name: 'Instacart', amount_usd: 64.35, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Pay Walmart for the curbside pickup order, $45.12, with my debit card.', payee_name: 'Walmart', amount_usd: 45.12, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Buy the new reading glasses from Warby Parker, $95.', payee_name: 'Warby Parker', amount_usd: 95, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Renew my Costco membership at the counter, $65.', payee_name: 'Costco', amount_usd: 65, payment_method: 'card', contact_channel: 'in_person' } },

  // Subscriptions
  { verdict: 'unknown', input: { description: 'Renew my Audible subscription with Google Play.', payee_name: 'Audible', amount_usd: 14.95, contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Pay for my YouTube Premium subscription billed through Google Play, $13.99.', payee_name: 'YouTube Premium', amount_usd: 13.99, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Buy an app with Google Play for my crossword puzzles, $4.99.', payee_name: 'Google Play', amount_usd: 4.99, contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Renew my Netflix subscription, $15.49 on my card.', payee_name: 'Netflix', amount_usd: 15.49, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Pay for The New York Times digital subscription, $4 a month.', payee_name: 'The New York Times', amount_usd: 4, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Renew my AARP membership for $16 with my credit card.', payee_name: 'AARP', amount_usd: 16, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay for SiriusXM radio in my car, $10.99 a month.', payee_name: 'SiriusXM', amount_usd: 10.99, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Renew my Amazon Prime membership, $139.', payee_name: 'Amazon', amount_usd: 139, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Pay with my card for the Apple Music family plan, $16.99.', payee_name: 'Apple', amount_usd: 16.99, payment_method: 'card', contact_channel: 'email' } },

  // Gifts for grandchildren and family
  { verdict: 'unknown', input: { description: 'Send $50 to my granddaughter Emily for her birthday with Zelle.', payee_name: 'Emily Ellis', amount_usd: 50, payment_method: 'zelle' } },
  { verdict: 'unknown', input: { description: "Buy a $25 Target gift card for my grandson's birthday.", payee_name: 'Target', amount_usd: 25, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Buy a $100 Amazon gift card as a Christmas present for my grandson Tyler.', payee_name: 'Amazon', amount_usd: 100 } },
  { verdict: 'unknown', input: { description: 'Send my grandson $40 on Venmo for his graduation.', payee_name: 'Tyler Ellis', amount_usd: 40, payment_method: 'payment_app' } },
  { verdict: 'unknown', input: { description: 'Mail a check for $100 to my granddaughter for her wedding.', payee_name: 'Emily Ellis', amount_usd: 100, payment_method: 'check' } },
  { verdict: 'unknown', input: { description: "Order the LEGO castle set from LEGO.com for my grandson's birthday, $59.99.", payee_name: 'LEGO', amount_usd: 59.99, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Buy the blue bicycle at Walmart for my granddaughter, $129, by card.', payee_name: 'Walmart', amount_usd: 129, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'My daughter bought my groceries. Pay her back the $60 with Zelle.', payee_name: 'Sarah Ellis', amount_usd: 60, payment_method: 'zelle', contact_channel: 'text' } },

  // Donations
  { verdict: 'unknown', input: { description: 'Donate $50 to the American Red Cross for hurricane relief, by card.', payee_name: 'American Red Cross', amount_usd: 50, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Donation to ETH Zurich alumni fund, $100, by card.', payee_name: 'ETH Zurich Foundation', amount_usd: 100, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: "Give $25 to St. Jude Children's Research Hospital with my credit card.", payee_name: "St. Jude Children's Research Hospital", amount_usd: 25, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Write a $40 check to First Baptist Church for the building fund.', payee_name: 'First Baptist Church', amount_usd: 40, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Donate $30 to Second Harvest Food Bank.', payee_name: 'Second Harvest Food Bank', amount_usd: 30, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Renew my public radio membership with WNYC during the pledge drive, $60.', payee_name: 'WNYC', amount_usd: 60, payment_method: 'card', contact_channel: 'phone_call' } },

  // Contractors and services at home
  { verdict: 'unknown', input: { description: 'The roofer, Greenleaf Roofing, wants a $1,500 deposit by check before he starts on the gutters next week.', payee_name: 'Greenleaf Roofing', amount_usd: 1500, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Smith Bros.Roofing the $450 for fixing the gutters, by check.', payee_name: 'Smith Bros.Roofing', amount_usd: 450, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: "Pay Joe's Plumbing $185 for fixing the leak under the sink, in cash.", payee_name: "Joe's Plumbing", amount_usd: 185, payment_method: 'cash', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Green Thumb Landscaping $60 for mowing, with Zelle.', payee_name: 'Green Thumb Landscaping', amount_usd: 60, payment_method: 'zelle', contact_channel: 'text' } },
  { verdict: 'unknown', input: { description: 'Pay Molly Maid for the house cleaning, $120 by card.', payee_name: 'Molly Maid', amount_usd: 120, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: 'Pay the handyman, Bob Turner, $75 in cash for hanging the pictures.', payee_name: 'Bob Turner', amount_usd: 75, payment_method: 'cash', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay ABC Heating and Cooling $89 for the furnace tune-up, by check.', payee_name: 'ABC Heating and Cooling', amount_usd: 89, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the electrician, Bright Spark Electric, $240 for the new outlets, by card.', payee_name: 'Bright Spark Electric', amount_usd: 240, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Harmony Piano Tuning $110 by check.', payee_name: 'Harmony Piano Tuning', amount_usd: 110, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Rapid Rooter for the emergency repair when my basement flooded, $300, by check.', payee_name: 'Rapid Rooter', amount_usd: 300, payment_method: 'check', contact_channel: 'in_person' } },

  // Doctors, dentists and pharmacies
  { verdict: 'unknown', input: { description: "Pay my $40 copay at Dr. Patel's office with my card.", payee_name: 'Dr. Patel', amount_usd: 40, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the dentist bill for the ether used in my tooth extraction, $210, by check.', payee_name: 'Riverside Dental', amount_usd: 210, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pick up my prescription at CVS Pharmacy, the copay is $12.50, with my card.', payee_name: 'CVS Pharmacy', amount_usd: 12.5, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Walgreens for my blood pressure pills, $8.75.', payee_name: 'Walgreens', amount_usd: 8.75, contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: "Pay the hospital bill from St. Mary's Hospital, $350, from my bank account.", payee_name: "St. Mary's Hospital", amount_usd: 350, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay the physical therapy bill from Riverside PT, $95.', payee_name: 'Riverside PT', amount_usd: 95, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'verified', input: { description: 'Pay my Medicare Part B premium, $174.70, from my bank account.', payee_name: 'Medicare', amount_usd: 174.7, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay for my hearing aid batteries at the Costco pharmacy, $9.99.', payee_name: 'Costco Pharmacy', amount_usd: 9.99, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the eye doctor, Dr.Smith, the $65 copay by card.', payee_name: 'Dr.Smith', amount_usd: 65, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'hold_for_family', input: { description: 'Pay the urgent care clinic bill, $150.', payee_name: 'CityMD Urgent Care', amount_usd: 150, payment_method: 'card', contact_channel: 'mail' } },

  // Local government fees
  { verdict: 'unknown', input: { description: 'Renew my car registration with the Virginia DMV, $40.75, by card.', payee_name: 'Virginia DMV', amount_usd: 40.75, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my property tax to the Fairfax County Treasurer, $1,240, by check.', payee_name: 'Fairfax County Treasurer', amount_usd: 1240, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay the City of Springfield for the dog license, $15.', payee_name: 'City of Springfield', amount_usd: 15, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my parking ticket to the Springfield Municipal Court online, $35, by card.', payee_name: 'Springfield Municipal Court', amount_usd: 35, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Buy my fishing license from the Virginia Department of Wildlife Resources, $25.', payee_name: 'Virginia Department of Wildlife Resources', amount_usd: 25, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Renew my passport; the $130 fee goes to the U.S. Department of State by check.', payee_name: 'U.S. Department of State', amount_usd: 130, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my library fine at the Springfield Public Library, $3.50 in cash.', payee_name: 'Springfield Public Library', amount_usd: 3.5, payment_method: 'cash', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the water and sewer bill to the Town of Greenwich, $88.', payee_name: 'Town of Greenwich', amount_usd: 88, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my E-ZPass toll bill, $22.40.', payee_name: 'E-ZPass', amount_usd: 22.4, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Send the County Clerk $20 for a copy of my marriage certificate.', payee_name: 'County Clerk', amount_usd: 20, payment_method: 'check', contact_channel: 'mail' } },

  // Housing, insurance, pets and everyday errands
  { verdict: 'unknown', input: { description: 'Pay my rent to Oak Grove Apartments, $1,150, by check.', payee_name: 'Oak Grove Apartments', amount_usd: 1150, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay my Medicare supplement premium to AARP UnitedHealthcare, $198, from my bank account.', payee_name: 'AARP UnitedHealthcare', amount_usd: 198, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay my car insurance to State Farm, $142.60, by card.', payee_name: 'State Farm', amount_usd: 142.6, payment_method: 'card', contact_channel: 'email' } },
  { verdict: 'unknown', input: { description: "Pay Paws Animal Clinic $85 for Buddy's shots.", payee_name: 'Paws Animal Clinic', amount_usd: 85, payment_method: 'card', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay my hairdresser $45 with Apple Cash.', payee_name: 'Linda Morales', amount_usd: 45, payment_method: 'payment_app', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the newspaper delivery boy $20 in cash for the month.', payee_name: 'Danny Kim', amount_usd: 20, payment_method: 'cash', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay the HOA dues to Maple Ridge Homeowners Association, $250, by check.', payee_name: 'Maple Ridge Homeowners Association', amount_usd: 250, payment_method: 'check', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay for the senior center lunch program this month, $30, by check.', payee_name: 'Springfield Senior Center', amount_usd: 30, payment_method: 'check', contact_channel: 'in_person' } },
  { verdict: 'unknown', input: { description: 'Pay Yellow Cab $28 for the ride to the doctor.', payee_name: 'Yellow Cab', amount_usd: 28, payment_method: 'card', contact_channel: 'phone_call' } },
  { verdict: 'unknown', input: { description: "Pay my Lowe's credit card bill, Acct.No 4417, $212.33 from my bank account.", payee_name: "Lowe's", amount_usd: 212.33, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay U.S.Bank for my car loan, $310.', payee_name: 'U.S. Bank', amount_usd: 310, payment_method: 'bank_transfer', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'Pay J.Crew for the sweater I ordered, $68.', payee_name: 'J.Crew', amount_usd: 68, payment_method: 'card', contact_channel: 'website' } },
  { verdict: 'unknown', input: { description: 'Pay the St.Louis Post-Dispatch for my newspaper subscription, $24.', payee_name: 'St. Louis Post-Dispatch', amount_usd: 24, payment_method: 'card', contact_channel: 'mail' } },
  { verdict: 'unknown', input: { description: 'I paid the florist last week, now pay the $55 for the flowers for my sister.', payee_name: 'Bloom Florist', amount_usd: 55, payment_method: 'card', contact_channel: 'phone_call' } },
];
