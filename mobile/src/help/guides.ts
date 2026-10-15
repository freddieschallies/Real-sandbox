// Step-by-step guides, by role: what each person needs to do their own work in the app. Shown in the
// "How to use the app" corner at the bottom of every front page. Button names are the app's own.

export interface Guide { id: string; title: string; roles: string[]; steps: string[] }
const ALL = ['technician', 'mechanic', 'admin', 'accounts', 'stockroom', 'management', 'hr', 'director', 'creator'];
const OFFICE = ['admin', 'accounts', 'management', 'hr', 'director', 'creator'];
const CEO = ['director', 'creator'];

export const GUIDES: Guide[] = [
  // ---- Everyone ----------------------------------------------------------------------------------
  { id: 'first-login', title: 'Sign in for the first time', roles: ALL, steps: [
    'The office sends you a message with your email and a setup code.',
    'Open the app and tap "I have a setup code".',
    'Type your email and the setup code.',
    'Choose your own password (at least 8 characters) and type it twice. Nobody else knows it, not even the office.',
    'Tap "Save my password and sign in". Read the monitoring policy to the end and accept it.',
  ] },
  { id: 'forgot', title: 'I forgot my password, or my login is locked', roles: ALL, steps: [
    'Five wrong passwords lock your login for a while.',
    'Ask Admin or the CEO for a new setup code (they find you under People → your name → Login).',
    'Sign in with "I have a setup code" and choose a new password.',
  ] },
  { id: 'search', title: 'Find anything quickly (search)', roles: ALL, steps: [
    'Tap the magnifying glass at the top of your front page.',
    'Type part of what you want: a job number, a store, a part code, a person, or a screen ("timesheet", "prices").',
    'Under GO TO are the screens you can open; below are the job cards, stock and documents you may see.',
    'Tap a result to open it. Tap ‹ to close the search.',
  ] },
  { id: 'signal', title: 'No signal on site', roles: ALL, steps: [
    'Keep working: what you do waits on the phone and is sent when there is signal again.',
    'The pill at the top shows how many things are waiting. Tap it to see them.',
    'Some things need signal (loading new jobs, search, purchase orders). The app tells you when.',
  ] },
  { id: 'dark', title: 'Light or dark screen', roles: ALL, steps: [
    'Tap the sun or moon button at the top.',
    'Dark is easier on the eyes at night; light is easier to read in bright sun. Each phone keeps its own choice.',
  ] },

  // ---- Technician ----------------------------------------------------------------------------------
  { id: 'tech-job', title: 'Do a job from start to finish', roles: ['technician'], steps: [
    'On My day, tap the job.',
    'Leaving for the store: tap "Go – I\'m on the way" (the travel timer starts).',
    'At the store: tap "Confirm arrived", type the store manager you checked in with, and tick the safety checks.',
    'Tap "Start job – timer starts". Open each work item and fill it in; "Done" works only when everything is there.',
    'Breaks or waiting for parts: "Pause", then "Resume work".',
    'Finished: "Store manager sign-off". The manager signs on the screen, then "Close job – signed".',
  ] },
  { id: 'tech-later', title: 'Can\'t finish today (continue later)', roles: ['technician'], steps: [
    'On the job, tap "Continue later (another day)".',
    'Write the progress so far, when you will come back, and who at the store you told.',
    'Need a part and a new quote? Answer Yes and follow "Make the parts report": photos of the machine, the serial tag and the part.',
    'Tap "Leave site – continue later". The office sees it at once.',
  ] },
  { id: 'tech-stock', title: 'Book stock for a job, and return what is left', roles: ['technician'], steps: [
    'On the job (or "Book stock before you leave" on My day), tap "Book stock".',
    'Search the part, set how many, and send it. The stock controller picks it and issues it to you.',
    'Parts you used go on the job card. What is left: My stock → "Return stock". It stays on your name until the stockroom confirms it.',
  ] },
  { id: 'tech-slip', title: 'Bought parts at a supplier (scan the slip)', roles: ['technician'], steps: [
    'Ask for a purchase order first if you need one (see the next guide).',
    'At the counter: My stock → "Scan invoice", take a clear photo of the slip, and "Send for reading".',
    'Check what was read: supplier, invoice number, each line and the total. Fix anything wrong.',
    'Tap "Confirm – put it on my name". The parts are on the job or your van; Accounts checks the slip.',
  ] },
  { id: 'tech-po', title: 'Ask for a purchase order', roles: ['technician'], steps: [
    'For a job: open the job card → Purchase orders for this job → Ask for a PO. For sundries or van stock: on your main page → Purchase orders: sundries.',
    'Tap "Take a photo of the list or quote": the app reads it and fills in the supplier and the parts.',
    'Check what it read, fix anything wrong (or type the parts yourself), then Send for approval.',
    'Once approved, show the PO number at the supplier and scan their slip against it.',
  ] },
  { id: 'tech-timesheet', title: 'Submit my timesheet, and add office time', roles: ['technician'], steps: [
    'My day → Timesheet. The app made yesterday\'s sheet from your jobs: travel, work, pauses.',
    'Was there a meeting, or did you get the van ready? Tap "+ Add office time", tap what it was, set the start with + and −, tap how long, and Save. It is paid time.',
    'Driving back to the workshop after your last job: add it the same way ("Driving back to the workshop").',
    'If time is still "not accounted for", write what it was. Then tap "Submit". Do it before 10:00 the next morning.',
  ] },
  { id: 'tech-vehicle', title: 'Take a vehicle, report a fault, release it', roles: ['technician'], steps: [
    'My day → Vehicle: scan the QR sticker on the dashboard (or type the code). Choose Driving.',
    'Do the quick handover check. Tick anything wrong: it goes to the mechanic.',
    'Something breaks: on the vehicle card tap "Report a fault", say what is wrong, and whether it is unsafe to drive.',
    'Done with it: "Release vehicle", with the km now and where you left it.',
  ] },
  { id: 'tech-fuel', title: 'Fill up with fuel', roles: ['technician'], steps: [
    'Be scanned into the vehicle first.',
    'My day → Fuel: the litres and the amount paid, and a photo of the slip.',
    'Tap "Save fuel".',
  ] },
  { id: 'tech-quote', title: 'Make a quote for the office', roles: ['technician'], steps: [
    'On an open job: "Submit a quote for this job". Or My day → Quotes → "New quote" for a store.',
    'Add the labour hours, the parts and anything to buy, with rough prices if you know them.',
    'Tap "Submit the quote to the office". The office prices it and sends it to the client.',
  ] },
  { id: 'tech-questions', title: 'Answer a question or a flag', roles: ['technician'], steps: [
    'Questions and flags show on My day in yellow.',
    'Open it, read what is asked, write your explanation, and "Send answer". Your manager sees it.',
    'Queries: messages from the office or other technicians; answer them there.',
  ] },

  // ---- Office: jobs ------------------------------------------------------------------------------
  { id: 'office-breakdown', title: 'Log a breakdown as a job', roles: ['admin', 'management', ...CEO], steps: [
    'Breakdowns: every breakdown email and WhatsApp message lands here, read for the store, fault and call number.',
    'Open it and check the store and the fault. Tap "Log it as a job", or "Not a job" with the reason (already fixed, duplicate…).',
    'Choose the technician and the date, and save. He sees it on his phone at once.',
  ] },
  { id: 'office-whatsapp', title: 'Read and answer WhatsApp in the app', roles: ['admin', 'management', ...CEO], steps: [
    'Open WhatsApp: every chat of the app\'s number, newest first. A green number is unread.',
    'Tap a chat to read it. Type in "Type a reply" and tap Send: it goes out with your name under it.',
    'Messages in the breakdowns group go into Breakdowns by themselves. A message in another chat that is a breakdown: tap "Make it a breakdown".',
    'With an official number, WhatsApp only allows a reply within 24 hours of their last message.',
  ] },
  { id: 'ceo-whatsapp', title: 'Connect WhatsApp', roles: CEO, steps: [
    'Start-up → WhatsApp (or Settings). Choose: "Our own phone" (works in your existing breakdowns group) or "Official business number" (no phone; stores message the number).',
    'Own phone: a cheap phone with its own SIM and WhatsApp, added to the breakdowns group. Tap "The phone is ready: show the code".',
    'On that phone: WhatsApp → ⋮ → Linked devices → Link a device, and scan the code on your screen.',
    'Choose the breakdowns group, then "Send a test" and say whether it arrived. Done.',
    'Official number: tap "Connect with WhatsApp", follow WhatsApp\'s window, then send the number a "Hi" from your own phone.',
  ] },
  { id: 'office-job', title: 'Open, change or cancel a job', roles: ['admin', 'management', ...CEO], steps: [
    'Jobs → "New job": the store, the fault, the technician and the date.',
    'Open a job to change anything; every change is written on the job and the technician is told.',
    'Cancel a job: open it, Cancel, and say whether the client or we cancelled it.',
  ] },
  { id: 'office-query', title: 'Ask a technician something', roles: ['admin', 'management', ...CEO], steps: [
    'Queries → "Send a query to a technician": choose him (and the job if it is about one), type your question, and "Send query".',
    'His answer comes back in the same thread.',
  ] },

  // ---- Office: money -----------------------------------------------------------------------------
  { id: 'acc-invoice', title: 'Invoice a closed job', roles: ['admin', 'accounts', ...CEO], steps: [
    'Invoices: the closed jobs waiting are at the top. Tap one to make its invoice.',
    'The lines come from the job: labour from the timers, call-out, travel, parts at the client\'s mark-up. Check and price them.',
    'Send it, then "Print / save as PDF" for the letterhead copy.',
    'When it is paid: open it and mark it Paid with the payment reference.',
  ] },
  { id: 'acc-credit', title: 'Credit an invoice, or close a job at no charge', roles: ['accounts', ...CEO], steps: [
    'Credit: open the invoice → credit note, the amount (or all of it) and why. The invoice stays as it was.',
    'No charge (warranty, callback, goodwill): open the closed job and mark it no charge with the reason, instead of invoicing it.',
  ] },
  { id: 'acc-supplier', title: 'Process a supplier invoice', roles: ['accounts', ...CEO], steps: [
    'Supplier invoices → "Take a photo of an invoice", or "Choose a file" for a PDF from email.',
    'It is read by itself. Check it next to the picture; tick the stockroom delivery it came in on.',
    'Tap "Save and approve" (or "Query it" with a note). Technicians\' till slips come in here by themselves to approve.',
  ] },
  { id: 'acc-statement', title: 'Send a customer statement (30 / 60 / 90 / 120 days)', roles: ['accounts', 'admin', ...CEO], steps: [
    'Customers → the customer → Statement (or Debtors → the customer → "Statement: print or email it").',
    'Choose the period: this month, last month, 3 or 12 months, or everything.',
    'Check the balance and the ages, then "Print / save as PDF (letterhead)" or type the customer\'s email and "Send the statement".',
  ] },
  { id: 'acc-hold', title: 'Put an account on hold', roles: ['accounts', ...CEO], steps: [
    'Debtors → the customer → "Put the account on hold", with the reason.',
    'Anyone opening a job for that customer is warned in red and must tick "Open it anyway". You are told.',
    'Paid up: open it again and take it off hold.',
  ] },
  { id: 'acc-pastel', title: 'Send invoices to Pastel', roles: ['accounts', 'admin', ...CEO], steps: [
    'Accounts → Pastel: give each customer its Pastel code and set the line codes once.',
    'Make a batch of invoices, credit notes or supplier invoices and import the file into Sage Pastel Partner.',
  ] },
  { id: 'acc-rates', title: 'Set a customer\'s own rates and mark-up', roles: ['accounts', ...CEO], steps: [
    'Accounts → Customers: codes and rates → Rates on the customer.',
    'Set their labour, call-out, travel per km and travel time; untick what they are not charged.',
    'Parts mark-up in three bands: the cheaper the part, the bigger the mark-up.',
  ] },
  { id: 'office-po', title: 'Approve a purchase order', roles: ['stockroom', 'admin', 'management', 'accounts', ...CEO], steps: [
    'Purchase orders → To approve.',
    'Check the supplier, the parts and the job. Tap "Approve", or "No" with the reason (the technician is told).',
    'A PO posted in the purchase orders WhatsApp group comes in by itself; link it to the job if it does not say which.',
  ] },

  // ---- People and timesheets ---------------------------------------------------------------------
  { id: 'hr-add', title: 'Add an employee and give them a login', roles: ['hr', 'admin', ...CEO], steps: [
    'People → "Add a person": name, email (what they sign in with), cell, role and department.',
    'Admin or the CEO: open the person → Login → "Give a setup code".',
    'Copy the message or "Send by WhatsApp". They choose their own password with it. The code works once, for 7 days.',
  ] },
  { id: 'hr-timesheets', title: 'Check and print timesheets', roles: ['hr', 'management', 'accounts', ...CEO], steps: [
    'Timesheets: Daily, Weekly or Monthly, for one person, a department or everyone.',
    'Each sheet shows travel, work, office time, hours invoiced and unauthorised trips. Open one to take office time off (he is told) or allow a trip.',
    'Monthly → one person: his statement. "Print / save as PDF", or "Download for Excel".',
    'Printing his copy? Tick "Hide performance on the print-out".',
  ] },
  { id: 'hr-departments', title: 'Departments and managers', roles: ['hr', ...CEO], steps: [
    'Departments: every department with its manager and technicians.',
    'Move a technician to another department, give a department its manager, switch one off or add your own.',
  ] },
  { id: 'hr-leaver', title: 'Someone leaves the company', roles: ['hr', ...CEO], steps: [
    'People → the person → "End … employment" at the bottom, with the reason and date.',
    'Their login stops at once, and the checklist shows what is still on their name (stock, tools, PPE, vehicle).',
    'They move to Terminated staff (bottom of People) with their record.',
  ] },
  { id: 'mgr-team', title: 'Run my team', roles: ['management'], steps: [
    'Team map: where each of your technicians is now. Tap a name for the job and the vehicle.',
    'Flags: answer what the app raised about your team (late to site, stock short).',
    'Van stock: your department\'s list of spares every van must carry.',
  ] },

  // ---- Stockroom ---------------------------------------------------------------------------------
  { id: 'stock-issue', title: 'Issue a technician\'s stock request', roles: ['stockroom'], steps: [
    'To issue: open the request.',
    'Tick each item as you pick it, then issue it. It goes on his name and his job.',
  ] },
  { id: 'stock-receive', title: 'Receive returned stock, or a delivery', roles: ['stockroom'], steps: [
    'To receive: count what the technician sent back and tick it; it comes off his name.',
    'A supplier delivery: Stock → delivery, the items and how many. "To order" clears by itself.',
  ] },
  { id: 'stock-tools', title: 'Book out a tool or ladder', roles: ['stockroom'], steps: [
    'Tool store: scan or type the tool\'s code.',
    'Book it out to the person for their job; they sign on the screen.',
    'When it comes back, sign it back in with its condition.',
  ] },

  { id: 'stock-take', title: 'Do a stock take', roles: ['stockroom'], steps: [
    'Stock take → choose what to count (Stock, Tools, PPE or Everything) → "Start a stock take".',
    'Want to count on paper first? "Print a count sheet".',
    'Find each item (type its code or name), type how many are on the shelf and tap ✓. What the app expected shows only after you count.',
    '"Differences" shows what is short or over and what it is worth.',
    '"Sign off the stock take", saying why the counts differ. The stockroom is corrected and Accounts is told. "Print the results" for the file.',
  ] },
  { id: 'stock-order', title: 'Order stock from a supplier (purchase order)', roles: ['stockroom'], steps: [
    'To order: everything below its minimum, with who it was last bought from, when and at what price.',
    'Untick what you don\'t want now, check the supplier and how many on each item.',
    'Tap "Make the PO for …": one PO per supplier.',
    'Send it: "Email the purchase order" (on the letterhead), "Send by WhatsApp", or print it.',
    'When the goods arrive: Stock → "Receive a delivery" and choose the PO: the items fill in by themselves.',
  ] },
  { id: 'stock-suppliers', title: 'Keep suppliers\' contact details', roles: ['stockroom'], steps: [
    'Suppliers → the supplier → "Contact details".',
    'The person, the email for orders and the cell number for WhatsApp. Purchase orders then go straight to them.',
  ] },
  { id: 'numbers', title: 'Carry on the numbering from the old system', roles: ['accounts', ...CEO], steps: [
    'Accounts → Numbering (or Start-up → Carry on your numbering).',
    'Type the next job card, invoice, quote, credit note and purchase order numbers, carrying on from your old system (last invoice 48000: type 48001).',
    'Save. A number can\'t be at or below one already used, so they never clash.',
  ] },

  // ---- Fleet -------------------------------------------------------------------------------------
  { id: 'fleet-check', title: 'Daily vehicle checks', roles: ['mechanic'], steps: [
    'Vehicles → each vehicle in service → daily check: odometer, oil, water, tyres.',
    'Oil added: always the litres. A problem: write what it is; it becomes a fault.',
  ] },
  { id: 'fleet-job', title: 'Fix a fault (mechanic job card)', roles: ['mechanic'], steps: [
    'Faults: the worst first. Open the vehicle and start a job card for it.',
    'Fill in what you found and what you did, the hours, the parts, an after photo and the odometer.',
    'Say whether it can go back on the road, and complete the card.',
  ] },

  // ---- The CEO -----------------------------------------------------------------------------------
  { id: 'ceo-startup', title: 'Set up the company (start-up checklist)', roles: CEO, steps: [
    'Office → Start-up (or Settings → Start-up checklist).',
    'Go down the steps in order: company details, logo and letterhead, departments, employees and their roles, logins, rates, customers.',
    'Employees: type several at once, each with their role, then "Add these people".',
    'Logins: "Make setup codes", then send each person their message.',
  ] },
  { id: 'acc-pay', title: 'Set what someone is paid', roles: ['accounts', ...CEO], steps: [
    'People → the person → Pay: by the hour (wage per hour) or a monthly salary, the overtime and Sunday / public holiday multiples.',
    'For a technician also what an hour of him costs the company (for profit); empty uses the company rate.',
    'His wages are worked out on his timesheets (Timesheets → Monthly): only Accounts and the CEO see them.',
    'Only Accounts and the CEO see pay. The CEO can switch "Employees\' pay" on for someone else (People → that person → Work).',
  ] },
  { id: 'acc-client-rates', title: 'A client\'s own rates and parts mark-up', roles: ['accounts', ...CEO], steps: [
    'Customers → the client → Rates and mark-up.',
    'Untick what this client is not charged; change the amounts.',
    'Mark-up on parts in three price bands (cheap parts a bigger %): the example shows what a R100, R1 000 and R5 000 part sells at.',
    'The next invoice for this client is priced with these.',
  ] },
  { id: 'ceo-access', title: 'Decide who may do what', roles: CEO, steps: [
    'People → the person → Position: their role (technician, admin, accounts, stock controller, manager, HR, mechanic).',
    'Under the position, switch extra work on or off for that person (e.g. give Admin the stockroom when the stock controller is away).',
    'Every change is kept in the access log.',
  ] },
  { id: 'ceo-worth', title: 'See what a technician makes and costs', roles: ['accounts', ...CEO], steps: [
    'Timesheets → Monthly → the technician.',
    'Tap "Performance not shown · change", tick "Show performance on his monthly timesheet", and set his cost per hour if it differs.',
    'His card shows his performance and, for you only, what he made against what he cost.',
  ] },
  { id: 'ceo-vehicles', title: 'Keep an eye on the vehicles', roles: [...CEO, 'admin', 'management'], steps: [
    'Open Vehicles. The tiles on top show what needs you: handovers to approve, safety faults, services and licence discs due, daily checks, trips not allowed, fuel and km. Tap a tile to open that part.',
    'Handovers: a driver took a vehicle with nobody to sign. Check the photos and problems, then Approve or Reject (rejecting needs a note).',
    'Trips: trips with a company vehicle that need a reason. If he was sent, tap "Allow it" and say why; it stops counting on his timesheet.',
    'Tap a vehicle for everything about it: job cards, bookings, daily checks, km, faults, who drove it, fuel slips and trips. From there you can book it in, open a job card or put a tech in.',
    'Change the Month at the top to look back (fuel, km and trips are per month).',
  ] },
];

/** The guides for this person's role, everyone's last. */
export function guidesFor(level: string): Guide[] {
  const mine = GUIDES.filter(g => g.roles.includes(level) && g.roles.length < ALL.length);
  const everyone = GUIDES.filter(g => g.roles.length === ALL.length);
  return [...mine, ...everyone];
}
export const OFFICE_ROLES = OFFICE;
