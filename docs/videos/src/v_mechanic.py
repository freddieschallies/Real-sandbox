import asyncio, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vlib import Video, V

async def main():
    async with Video('mechanic') as v:
        pg = v.pg
        await v.card('How to use the app', 'For the mechanic', 'The fleet app: every vehicle, its daily checks, faults, bookings and repairs.',
                     ['Daily checks', 'Vehicles and their faults', 'Bookings and repair job cards', 'Workshop stock', 'QR codes for the vehicles'], hold=7)
        await v.start('Open as mechanic')
        await v.uncard()
        await v.say('Every vehicle in service gets a daily check: oil, water and tyres. Oil added is always noted.')
        await v.maybe(pg.get_by_text(re.compile(r'^Check ND')).first, after=1.5)
        await v.wait(1.5)
        await v.tab('Vehicles')
        await v.say('Vehicles: on the road or off, who drives it, the km, faults, and licence dates coming up.')
        await v.tap(pg.get_by_text('ND 412-778', exact=True).first, after=1.5)
        await v.say('Each vehicle: its faults, checks, fuel, trips and every repair.')
        await v.wait(1)
        await v.tab('Faults')
        await v.say('Faults: reported by the technicians at a handover or from their phone. Safety faults first.')
        await v.tab('Booked')
        await v.say('Booked: vehicles booked in for a service or repair.', 'Book one in; take it off the road if it is not safe to drive.')
        await v.tab('Jobs')
        await v.say('Repair job cards: the work done, parts from the workshop stock and the time.')
        await v.tab('Stock')
        await v.say('Workshop stock: oil, filters, brake pads. Used on job cards and daily checks.')
        await v.tab('QR codes')
        await v.say('QR codes: a sticker in each vehicle. Technicians scan it to say which vehicle they are in.')
        await v.say('Stuck? "How to use the app" has a step-by-step guide for everything.')
        await v.card('That is it', 'Thank you', 'Safe vehicles, on the road.', hold=4)

asyncio.run(main())
