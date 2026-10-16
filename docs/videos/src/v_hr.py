import asyncio, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vlib import Video, V

async def main():
    async with Video('hr') as v:
        pg = v.pg
        await v.card('How to use the app', 'For HR', 'People, departments, staff records and timesheets.',
                     ['Adding people', 'Departments', 'Staff records', 'When someone leaves', 'Timesheets for payroll'], hold=7)
        await v.start('Open as HR')
        await v.tab('People')
        await v.uncard()
        await v.say('People: everyone in the company, by position. Add a new person here.', 'Admin then gives them a setup code to sign in.')
        await v.maybe(pg.get_by_text(re.compile(r'^(\+ )?Add a person$')).first, after=1.5)
        await v.wait(1.5)
        await v.tab('People')
        await v.tap(pg.locator('[aria-label^="Person Thabo"]').first, after=1.5)
        await v.say('A person: contact details, emergency contact, start date, and their staff records.', 'Staff records (warnings, notes) are only for HR and the CEO.')
        await v.scroll(800, x=1000); await v.wait(1.5)
        await v.say('When someone leaves: "End employment". Their login stops, and the tools and stock on their name are listed for the stockroom.')
        await v.scroll(1500, x=1000); await v.wait(1)
        await v.tab('Departments')
        await v.say('Departments: put each technician and manager in one. Switch off a department the business does not have.')
        await v.wait(1.5)
        await v.tab('Timesheets')
        await v.say('Timesheets: every day, made by the app from jobs and trips, submitted by the technician.', 'Export them for the payroll (Excel or PDF).')
        await v.wait(1.5)
        await v.say('Stuck? "How to use the app" has a step-by-step guide for everything.')
        await v.card('That is it', 'Thank you', 'Everyone\'s records, kept in one place.', hold=4)

asyncio.run(main())
