-- A technician's purchase order request can start from a photo (a quote, a handwritten list, the part's label).
ALTER TYPE photo_kind ADD VALUE 'po_request';
