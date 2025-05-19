
# Introduction

Coulomb is an in-development toolkit for decentralized microblogging.
The motivating factor behind many of the design decisions lies in the
complexity many other decentralized communication systems and a hope
to explore simpler approaches. With that in mind, the system will be
built to support two "levels," or sets of capability: a **static**
mode, suitable for deployment with any simple static hosting scheme,
and a **dynamic** mode that supports more modern and flexible
interaction methods, but requires a specialized server setup.

# Architecture ideas/overview

## Level 1 - static hosting mode

This level is entirely controlled by writers that know how to index
and serialize posts.

- Individual posts are cryptographically signed by the owner so that posts can easily and safely be replicated to other locations
- Static (html) views of posts are generated alongside more serialization-friendly formats so repositories are easily accessible for viewing via static hosting, for indexing (by search engines, for example), or for ingest by other writers or servers
- Indices of static pages can also be generated for convenience: indices to find posts with a certain tag, for example, can be updated cheaply as each post is made
- User can pull replies from a "mailbox" index directed to them from all external repositories that the user follows; these can be (signed, public) replies or (encrypted, private) messages
- Replies to a user's posts from authors that the user follows can be integrated into the post views directly
- Javascript can be added to the static views to empower search further and dynamically verify cryptographic signatures
- Making the content public involves a simple push to the user's static hosting location(s) of choice, with limited file updates required for each post

## Level 2 - dynamic, specialized host software

This level makes use of a more typical client/server architecture.

- Mirror groups of repositories for users so that large chunks of updates can be pulled in few transactions
- Facilitate push-based updates, rather than pull-based updates, for lower-latency interactions
