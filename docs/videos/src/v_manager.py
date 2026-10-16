import asyncio, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vlib import Video, V

async def main():
    async with Video('department-manager') as v:
        pg = v.pg
        await v.card('How to use the app', 'For department managers', 'Your technicians: their jobs, where they are, their questions and flags, their van stock and their timesheets.',
                     ['Today and the jobs', 'Flags: explain and resolve', 'The team map', 'Van stock lists', 'Timesheets'], hold=7)
        await v.start('Open as department manager')
        await v.tab('Today')
        await v.uncard()
        await v.say('Today: your department\'s jobs, who is working and what needs you.')
        await v.tab('Jobs')
        await v.say('Jobs: every job card, with its status. Tap one for the visits, work done, photos and parts.', 'Tap "Technicians" to change the lead or add technicians and assistants to work with him. Every change is kept on the job.')
        await v.tap(pg.get_by_text(re.compile('Ice machine not dispensing')).first, after=1.5)
        await v.tap('Technicians', after=1.2)
        await v.say('More than one on a job: the lead signs it off; tick the technicians and assistants working with him.', 'Each one sees it on their phone and is told.')
        await v.tap(pg.get_by_label('With Nomvula Dlamini', exact=True), after=0.8)
        await v.tap('Save the technicians', after=1.5)
        await v.tab('Flags')
        await v.say('Flags: things the app noticed (a long trip, hours not accounted for, a missed daily check).', 'The technician explains; you read it and resolve it with a note.')
        await v.maybe(pg.locator('[aria-label^="Flag"]').first, after=1.5)
        await v.tab('Team map')
        await v.say('The team map: where your technicians are now, and which job they are on.')
        await v.wait(1.5)
        await v.tab('Van stock')
        await v.say('Van stock: what every van in your department must carry. Vans short of it are flagged, and the stockroom tops them up.')
        await v.wait(1)
        await v.tab('Timesheets')
        await v.say('Timesheets: your technicians\' days, made by the app from their jobs and trips.', 'Travel, work, office time, overtime, and anything not accounted for.')
        await v.wait(1.5)
        await v.tab('Price list')
        await v.say('Price list: every part and its price, for when a client asks.')
        await v.say('Stuck? "How to use the app" has a step-by-step guide for everything.')
        await v.card('That is it', 'Thank you', 'Your team, their work and their time: in one place.', hold=4)

asyncio.run(main())
