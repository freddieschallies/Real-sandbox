import asyncio, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vlib import Video, V

async def main():
    async with Video('admin') as v:
        pg = v.pg
        v.files = [f'{V}/po_list.jpg', f'{V}/service_form.pdf']
        await v.card('How to use the app', 'For the office (Admin)', 'The office screen: breakdowns coming in, jobs for the technicians, their questions and purchase orders, and everyone\'s logins.',
                     ['Breakdowns from email and WhatsApp, logged as jobs', 'Job cards: technician, documents for site', 'Approving purchase orders', 'Logins: setup codes for new people', 'The price list'], hold=7)
        # A technician asks for a purchase order by photo (behind the card).
        await v.start('Open as technician')
        await pg.get_by_text('Purchase orders: sundries', exact=True).click(); await v.wait(1)
        await pg.get_by_text(re.compile('^Ask for a PO', re.I)).first.click(); await v.wait(1)
        await pg.get_by_text('📷 Take a photo of the list or quote', exact=True).click(); await v.wait(3)
        await pg.get_by_text('Send for approval', exact=True).click(); await v.wait(1.5)
        await v.become('Admin')
        await v.tab('Today')
        await v.uncard()
        await v.say('Today: what needs the office now. Jobs carried over, urgent ones, flags and the team.', 'The menu on the left has everything your work allows.')
        await v.tab('Breakdowns')
        await v.say('Breakdowns: every email to the breakdowns inbox and every message in the WhatsApp group comes in here.', 'The app reads the store, the fault and the call log number. You check it.')
        await v.tap(pg.get_by_text(re.compile('^Our cold room at Corner Market')).first, after=1.5)
        await v.say('Right breakdown? Tap "Log it as a job".', 'Not a job (a statement, a thank-you)? Tap "Not a job".')
        await v.tap('Log it as a job', after=1.5)
        await v.say('The store and fault are filled in. Choose how urgent, the day and the technician.', 'You see how many open jobs each one has, and who is on a job right now.')
        await v.tap(pg.get_by_text('Urgent', exact=True).last, after=0.4)
        await v.tap(pg.get_by_text('Ayanda Mthembu', exact=True).last, after=0.6)
        await v.tap('Create job', after=2)
        await v.say('The job is on Ayanda\'s phone straight away. Its first work item is the fault reported.')
        await v.say('Documents for this job: add a form the technician needs on site, e.g. the client\'s own service report.', 'He sends it to the store to print (WhatsApp or email) and brings it back filled in.')
        await v.tap('+ Add a document', after=3)
        await v.say('Added. The technician sees it on his job card.')
        await v.tab('Purchase orders')
        await v.say('Purchase orders: a technician photographed what he needs; the app read it.', 'Check the parts and the photo, then approve: the PO number goes to his phone.')
        await v.tap(pg.get_by_text('Approve', exact=True).first, after=1.5)
        await v.tab('People')
        await v.say('A new person, or someone forgot their password: give them a setup code.', 'People → the person → Login.')
        await v.tap(pg.locator('[aria-label^="Person Ayanda"]').first, after=1.5)
        await v.scroll(1200, x=1000)
        await v.tap(pg.get_by_text(re.compile(r"^(Reset .* password|Give .*setup code)")).first, after=1.5)
        await v.say('Send the code by WhatsApp. It works once, for 7 days: they choose their own password with it.', 'Nobody, not even the office, ever knows anyone\'s password.')
        await v.tab('Price list')
        await v.say('Price list: every part and its price, for when a client asks. Add a picture of a part for the next person.')
        await v.type(pg.get_by_label('Find a part', exact=True), 'r404', delay=110)
        await v.tap(pg.locator('[aria-label^="Part "]').first, after=1.5)
        await v.say('Search anything from the magnifying glass at the top: a job number, a store, a part, a person, or a screen.')
        await v.point(pg.get_by_label('Search', exact=True).first); await v.wait(1.5)
        await v.say('Stuck? "How to use the app" has a step-by-step guide for everything.')
        await v.card('That is it', 'Thank you', 'Everything the office does is kept: who did what, and when.', hold=4)

asyncio.run(main())
