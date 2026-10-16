import asyncio, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vlib import Video, V

async def main():
    async with Video('stock-controller') as v:
        pg = v.pg
        await v.card('How to use the app', 'For the stock controller', 'The stockroom app: everything that comes in and goes out of the stockroom, on whose name it is, and what to order.',
                     ['Issue stock that technicians ask for', 'Your stock list, minimums and pictures', 'The order list and purchase orders', 'Deliveries, returns and stock takes'], hold=7)
        # A technician asks for stock for his job (shown briefly, behind the card).
        await v.start('Open as technician')
        await pg.get_by_text(re.compile('Ice machine not dispensing')).first.click(); await v.wait(1.2)
        await pg.get_by_text('Book stock', exact=True).first.click(); await v.wait(1)
        for l in ['More VALVE-01', 'More VALVE-01', 'More CONT-25A']: await pg.get_by_label(l, exact=True).first.click(); await v.wait(0.2)
        await pg.get_by_text('Send request: 2 items', exact=True).click(); await v.wait(1.5)
        await v.become('Stock controller')
        await v.uncard()
        await v.say('A technician asked for stock for his job. It waits here, under "To issue".', 'Nothing leaves the stockroom until you issue it.')
        await v.tap(pg.get_by_text(re.compile('^Job #10231')).first, after=1.2)
        await v.say('Pick each item from the shelf and tick it. Gave less? Change the number.', 'A photo is optional.')
        await v.tap(pg.get_by_label('Tick Water inlet valve 24V', exact=True), after=0.5)
        await v.tap(pg.get_by_label('Tick Contactor 25A 230V coil', exact=True), after=0.5)
        await v.tap('Issue to Thabo Mkhize', after=1.5)
        await v.say('Issued: it is now on Thabo\'s name for that job, until he uses it on the job card or brings it back.')
        await v.tab('Stock')
        await v.say('Stock: what is in the stockroom, what is with the technicians, and what must come back.')
        await v.type(pg.get_by_role('textbox', name='Search', exact=True), 'contacter', delay=80)
        await v.say('Search the way you speak: a code, part of a name, even with a typo.')
        await v.tap(pg.get_by_text(re.compile('^Contactor 25A 230V coil$')).first, after=1.5)
        await v.say('Each part: its minimum (when it goes on the order list), how many to reorder, the supplier and a picture.', 'Below the minimum? It goes on the order list by itself.')
        await v.tab('To order')
        await v.say('The order list: everything below its minimum, with the last supplier and price.', 'Tick what to order, choose how many, and make the purchase order for that supplier.')
        await v.point(pg.get_by_text(re.compile('^Make the PO for')).first); await v.wait(2)
        await v.tab('To receive')
        await v.say('To receive: stock the technicians bring back. Check it and sign it into the stockroom.', 'Deliveries from suppliers: Stock → "Receive a delivery", against their PO.')
        await v.tab('Stock take')
        await v.say('Stock take: count what is on the shelves. The app only shows what it expected after you count each item.', 'Then you see the differences, say why, and sign it off: the stockroom is corrected and Accounts is told.')
        await v.point('Start a stock take'); await v.wait(2)
        await v.tab('Tool store')
        await v.say('Tool store: ladders and tools with barcodes, booked out for a job with a signature and signed back.')
        await v.say('Stuck? "How to use the app" has a step-by-step guide for everything.')
        await v.card('That is it', 'Thank you', 'What the technicians ask for, what comes in and what goes out: all in one place.', hold=4)

asyncio.run(main())
