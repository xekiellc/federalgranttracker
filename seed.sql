-- Reference data: states (with population for per-capita calcs) and a starter
-- set of agencies. Opportunities/awards sync will reference these by slug/code.

INSERT INTO states (code, slug, name, population) VALUES
('AL','alabama','Alabama',5108468),('AK','alaska','Alaska',733583),
('AZ','arizona','Arizona',7431344),('AR','arkansas','Arkansas',3067732),
('CA','california','California',38965193),('CO','colorado','Colorado',5877610),
('CT','connecticut','Connecticut',3617176),('DE','delaware','Delaware',1031890),
('FL','florida','Florida',22610726),('GA','georgia','Georgia',11029227),
('HI','hawaii','Hawaii',1435138),('ID','idaho','Idaho',1964726),
('IL','illinois','Illinois',12549689),('IN','indiana','Indiana',6862199),
('IA','iowa','Iowa',3200517),('KS','kansas','Kansas',2937150),
('KY','kentucky','Kentucky',4526154),('LA','louisiana','Louisiana',4573749),
('ME','maine','Maine',1395722),('MD','maryland','Maryland',6164660),
('MA','massachusetts','Massachusetts',7001399),('MI','michigan','Michigan',10037261),
('MN','minnesota','Minnesota',5737915),('MS','mississippi','Mississippi',2939690),
('MO','missouri','Missouri',6196156),('MT','montana','Montana',1132812),
('NE','nebraska','Nebraska',1978379),('NV','nevada','Nevada',3194176),
('NH','new-hampshire','New Hampshire',1402054),('NJ','new-jersey','New Jersey',9290841),
('NM','new-mexico','New Mexico',2114371),('NY','new-york','New York',19571216),
('NC','north-carolina','North Carolina',10835491),('ND','north-dakota','North Dakota',783926),
('OH','ohio','Ohio',11785935),('OK','oklahoma','Oklahoma',4053824),
('OR','oregon','Oregon',4233358),('PA','pennsylvania','Pennsylvania',12961683),
('RI','rhode-island','Rhode Island',1095610),('SC','south-carolina','South Carolina',5373555),
('SD','south-dakota','South Dakota',924669),('TN','tennessee','Tennessee',7126489),
('TX','texas','Texas',30503301),('UT','utah','Utah',3417734),
('VT','vermont','Vermont',647464),('VA','virginia','Virginia',8715698),
('WA','washington','Washington',7812880),('WV','west-virginia','West Virginia',1770071),
('WI','wisconsin','Wisconsin',5910955),('WY','wyoming','Wyoming',587618),
('DC','district-of-columbia','District of Columbia',702250);

-- Agencies: HHS as parent, NIH as sub-agency, plus a few more used elsewhere
-- on the site (ticker examples, map). All slugs match /agency/:slug routes.
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('hhs', 'HHS', 'Department of Health and Human Services', NULL);
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('nih', 'NIH', 'National Institutes of Health', (SELECT id FROM agencies WHERE code = 'HHS'));
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('nsf', 'NSF', 'National Science Foundation', NULL);
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('doe', 'DOE', 'Department of Energy', NULL);
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('usda', 'USDA', 'Department of Agriculture', NULL);
INSERT INTO agencies (slug, code, name, parent_agency_id) VALUES ('dod', 'DOD', 'Department of Defense', NULL);
